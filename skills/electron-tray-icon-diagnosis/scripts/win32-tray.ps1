# Shared Win32 helper for the electron-tray-icon-diagnosis skill.
# Dot-source from sibling scripts:  . "$PSScriptRoot\win32-tray.ps1"
# Compiles type [TrayProbe] with ASCII-only literals so it is safe under PowerShell 5.1
# regardless of the script file encoding (no BOM requirement).

$script:TrayProbeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using System.Text;

public class TrayRow {
    public int Pid;
    public string Proc = "";
    public string Class = "";
    public bool Visible;
    public string Rect = "";
    public string Integrity = "";
    public string Elevated = "";
    public string IconRects = "";
    public string Registry = "";
    public string Note = "";
}

public static class TrayProbe {

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwPid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr hObject);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, int TokenInformationLength, out int ReturnLength);
    [DllImport("advapi32.dll")] static extern bool IsValidSid(IntPtr pSid);
    [DllImport("advapi32.dll", CharSet = CharSet.Auto, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr pSid, out string strSid);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct NID {
        public uint cbSize; public IntPtr hwnd; public uint uID; public uint uFlags;
        public uint uCallbackMessage; public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public int dwState; public int dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hIconReal;
    }

    // NOTIFYICONIDENTIFIER - the identifier form Shell_NotifyIconGetRect actually takes.
    // Feeding it a NOTIFYICONDATA (cbSize=976) yields E_INVALIDARG (0x80070057) for every uID,
    // which looks exactly like "icon not registered" - a false red, so keep these two structs apart.
    [StructLayout(LayoutKind.Sequential)]
    struct NII {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public Guid guidItem;
    }

    [DllImport("shell32.dll", SetLastError = true)] static extern int Shell_NotifyIconGetRect([In] ref NII pnid, out RECT rect);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Shell_NotifyIconW(uint dwMessage, [In] ref NID pnid);

    const uint NIM_ADD = 0;
    const uint NIM_MODIFY = 1;
    const uint NIM_DELETE = 2;
    const uint NIM_SETVERSION = 4;
    // NIF_ICON 0x2 | NIF_TIP 0x4 | NIF_SHOWTIP 0x80.
    // Do NOT set NIF_GUID (0x20) with a zero GUID and do NOT set NIF_MESSAGE without a
    // registered callback message - both make NIM_ADD fail, which would look like "shell refuses icons".
    const uint CTRL_FLAGS = 0x2 | 0x4 | 0x80;

    static NID MakeNid(IntPtr hwnd, uint uid) {
        NID n = new NID();
        n.cbSize = (uint)Marshal.SizeOf(typeof(NID));
        n.hwnd = hwnd;
        n.uID = uid;
        n.uVersion = 4;
        n.uFlags = 0;
        n.szTip = "";
        n.szInfo = "";
        n.szInfoTitle = "";
        return n;
    }

    public static int NidSize() { return Marshal.SizeOf(typeof(NID)); }
    public static int NiiSize() { return Marshal.SizeOf(typeof(NII)); }

    /// Variant probe. Returns "RECT|left,top,WxH", "NORECT|0x0" or "FAIL|0x........".
    /// Naming matters: hr=0 with a rect does NOT mean the icon is visible on the taskbar. Measured
    /// 2026-10-07 - a control icon that the user could not see on the bar reported the *same*
    /// 2282,1392,32x48 as every healthy app, because that is the overflow anchor, not its slot.
    /// The only real discriminator is FAIL (never reached the shell) vs not-FAIL (registered).
    public static string RectProbeVariant(IntPtr hwnd, uint uid, int cbSizeOverride) {
        NII n = new NII();
        n.cbSize = (uint)Marshal.SizeOf(typeof(NII));
        n.hWnd = hwnd;
        n.uID = uid;
        n.guidItem = Guid.Empty;
        if (cbSizeOverride > 0) n.cbSize = (uint)cbSizeOverride;
        RECT rc;
        int hr = Shell_NotifyIconGetRect(ref n, out rc);
        if (hr != 0) return "FAIL|0x" + hr.ToString("X8");
        int w = rc.Right - rc.Left;
        int h = rc.Bottom - rc.Top;
        if (w == 0 && h == 0) return "NORECT|0x0";
        return "RECT|" + rc.Left + "," + rc.Top + "," + w + "x" + h;
    }

    /// Probe a tray host window across uIDs.
    public static string RectProbe(IntPtr hwnd, int maxUid) {
        StringBuilder sb = new StringBuilder();
        int rect = 0, noRect = 0;
        for (uint u = 0; u <= (uint)maxUid; u++) {
            string r = RectProbeVariant(hwnd, u, 0);
            if (r.StartsWith("NORECT")) { noRect++; sb.Append("u" + u + ":registered-no-rect "); }
            else if (r.StartsWith("RECT")) { rect++; sb.Append("u" + u + ":" + r.Substring(5) + " "); }
        }
        sb.Append("=> registered=" + (rect + noRect) + " withRect=" + rect + " noRect=" + noRect + " of uID 0.." + maxUid);
        return sb.ToString();
    }
    static List<IntPtr> WindowsOfClasses(string[] classes) {
        List<IntPtr> hits = new List<IntPtr>();
        EnumWindowsProc cb = delegate (IntPtr h, IntPtr p) {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            string c = sb.ToString();
            foreach (string t in classes) {
                if (string.Equals(c, t, StringComparison.OrdinalIgnoreCase)) { hits.Add(h); break; }
            }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return hits;
    }

    public static List<TrayRow> TrayHostWindows() {
        string[] classes = {
            "Shell_TrayWnd", "TopLevelWindowForOverflowXamlIsland", "NotifyIconOverflowWindow",
            "XamlExplorerHostIslandWindow_WASDK", "SystemTray_Main", "TrayNotifyWnd",
            "Electron_NotifyIconHostWindow", "Chrome Legacy Window", "Qt51514WxTrayIconMessageWindowClass",
            "TopLevelWindowForOverflowXamlIsland_WASDK"
        };
        List<TrayRow> rows = new List<TrayRow>();
        foreach (IntPtr h in WindowsOfClasses(classes)) {
            TrayRow r = new TrayRow();
            uint pid; GetWindowThreadProcessId(h, out pid);
            r.Pid = (int)pid;
            r.Class = ClassNameOf(h);
            r.Visible = IsWindowVisible(h);
            RECT rc; GetWindowRect(h, out rc);
            r.Rect = rc.Left + "," + rc.Top + "," + (rc.Right - rc.Left) + "x" + (rc.Bottom - rc.Top);
            r.IconRects = "hwnd=0x" + ((long)h).ToString("X");
            try { r.Proc = System.Diagnostics.Process.GetProcessById(r.Pid).ProcessName; } catch { r.Proc = "<gone>"; }
            rows.Add(r);
        }
        return rows;
    }

    static string ClassNameOf(IntPtr h) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        return sb.ToString();
    }

    // PROCESS_QUERY_INFORMATION fails with ERROR_ACCESS_DENIED across integrity levels,
    // PROCESS_QUERY_LIMITED_INFORMATION (0x1000) usually still works - try both, otherwise a
    // High-IL explorer reads as "no-handle" and looks like the shell is missing.
    static IntPtr OpenForQuery(int pid) {
        IntPtr h = OpenProcess(0x0400, false, pid);
        if (h == IntPtr.Zero) h = OpenProcess(0x1000, false, pid);
        return h;
    }

    public static string IntegrityOf(int pid) {
        IntPtr h = OpenForQuery(pid);
        if (h == IntPtr.Zero) return "no-handle(err=" + Marshal.GetLastWin32Error() + ")";
        try {
            IntPtr tok;
            if (!OpenProcessToken(h, 0x0008 /*TOKEN_QUERY*/, out tok)) return "no-token(err=" + Marshal.GetLastWin32Error() + ")";
            try {
                int need;
                GetTokenInformation(tok, 25 /*TokenIntegrityLevel*/, IntPtr.Zero, 0, out need);
                if (need <= 0) return "no-size";
                IntPtr buf = Marshal.AllocHGlobal(need);
                try {
                    int got;
                    if (!GetTokenInformation(tok, 25, buf, need, out got)) return "query-fail(err=" + Marshal.GetLastWin32Error() + ")";
                    int[] offsets = new int[] { 0, 8 };
                    foreach (int off in offsets) {
                        IntPtr cand = Marshal.ReadIntPtr(buf, off);
                        string s;
                        if (cand != IntPtr.Zero && IsValidSid(cand) && ConvertSidToStringSid(cand, out s) && s.StartsWith("S-1-16-")) return s;
                    }
                    string inlineSid;
                    if (IsValidSid(buf) && ConvertSidToStringSid(buf, out inlineSid)) return inlineSid + "(inline)";
                    return "unparsed(bytes=" + need + ")";
                } finally { Marshal.FreeHGlobal(buf); }
            } finally { CloseHandle(tok); }
        } finally { CloseHandle(h); }
    }

    public static string ElevatedOf(int pid) {
        IntPtr h = OpenProcess(0x0400, false, pid);
        if (h == IntPtr.Zero) return "?";
        try {
            IntPtr tok;
            if (!OpenProcessToken(h, 0x0008 | 0x0020, out tok)) return "?";
            try {
                int need;
                GetTokenInformation(tok, 20 /*TokenElevation*/, IntPtr.Zero, 0, out need);
                if (need < 4) return "?";
                IntPtr buf = Marshal.AllocHGlobal(need);
                try {
                    int got;
                    if (!GetTokenInformation(tok, 20, buf, need, out got)) return "?";
                    return Marshal.ReadInt32(buf) != 0 ? "Elevated" : "not-elevated";
                } finally { Marshal.FreeHGlobal(buf); }
            } finally { CloseHandle(tok); }
        } finally { CloseHandle(h); }
    }

    /// Control registration: add an icon for this hwnd with the given tip.
    public static IntPtr AddControlIcon(IntPtr hwnd, uint uid, IntPtr hIcon, string tip) {
        NID n = MakeNid(hwnd, uid);
        n.uFlags = CTRL_FLAGS;
        n.hIcon = hIcon;
        n.szTip = tip;
        if (!Shell_NotifyIconW(NIM_ADD, ref n)) return IntPtr.Zero;
        Shell_NotifyIconW(NIM_SETVERSION, ref n);
        return hwnd;
    }

    public static bool ModifyControlIcon(IntPtr hwnd, uint uid, IntPtr hIcon, string tip) {
        NID n = MakeNid(hwnd, uid);
        n.uFlags = 0x2 | 0x4;
        n.hIcon = hIcon;
        n.szTip = tip;
        return Shell_NotifyIconW(NIM_MODIFY, ref n);
    }

    public static void DeleteControlIcon(IntPtr hwnd, uint uid) {
        NID n = MakeNid(hwnd, uid);
        Shell_NotifyIconW(NIM_DELETE, ref n);
    }

    public static string BroadcastTaskbarCreated() {
        IntPtr hwnd = FindWindowW("Shell_TrayWnd", null);
        if (hwnd == IntPtr.Zero) return "no Shell_TrayWnd";
        uint msg = RegisterWindowMessageW("TaskbarCreated");
        if (msg == 0) return "RegisterWindowMessage failed";
        SendMessageTimeoutW(hwnd, msg, IntPtr.Zero, IntPtr.Zero, 0x0002 /*SMTO_ABORTIFHUNG*/, 2000, IntPtr.Zero);
        return "broadcast msg=0x" + msg.ToString("X");
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessageW(string lpString);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, IntPtr lpdwResult);

    public static string NotifyIconSettings(string exePathFragment) {
        List<string> outLines = new List<string>();
        using (RegistryKey root = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings")) {
            if (root == null) return "NO-RUN: HKCU\\Control Panel\\NotifyIconSettings missing";
            string[] names = root.GetSubKeyNames();
            outLines.Add("subkeys=" + names.Length);
            foreach (string name in names) {
                using (RegistryKey k = root.OpenSubKey(name)) {
                    if (k == null) continue;
                    string exe = Convert.ToString(k.GetValue("ExecutablePath", ""));
                    if (exePathFragment.Length > 0 && exe.IndexOf(exePathFragment, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    object uid = k.GetValue("UID", null);
                    object tip = k.GetValue("InitialTooltip", null);
                    object snap = k.GetValue("IconSnapshot", null);
                    string lastWrite = LastWriteOf(k);
                    string png = SnapInfo(snap);
                    outLines.Add("id=" + name + " uid=" + (uid == null ? "-" : Convert.ToString(uid)) +
                        " tipLen=" + (tip == null ? "-" : Convert.ToString(tip).Length.ToString()) +
                        " tip=[" + (tip == null ? "" : Convert.ToString(tip)) + "]" +
                        " snap=" + png + " lastWrite=" + lastWrite + " exe=" + exe);
                }
            }
        }
        if (outLines.Count == 1) outLines.Add("(no key matched the exe filter)");
        return string.Join("\n", outLines.ToArray());
    }

    // Last write time straight off the handle .NET already opened. Rebuilding a 64-bit HKEY by hand
    // is a trap worth naming: predefined keys are sign-extended ((HKEY)(LONG)0x80000002), and passing
    // plain 0x80000002 to RegOpenKeyExW answers ERROR_FILE_NOT_FOUND(2) - which reads exactly like
    // "this exe has no tray state", i.e. a fabricated negative.
    // RegistryKey.Handle in .NET 4.x is a SafeRegistryHandle, not an IntPtr - take DangerousGetHandle().
    static string LastWriteOf(RegistryKey k) {
        try {
            IntPtr h = k.Handle.DangerousGetHandle();
            long lastWrite;
            int r = RegQueryInfoKeyW(h,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,           // lpClass, lpcClass, lpReserved
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,           // lpcSubKeys, lpcMaxSubKeyLen, lpcMaxClassLen
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,           // lpcValues, lpcMaxValueNameLen, lpcMaxValueLen
                IntPtr.Zero,                                     // lpcbSecurityDescriptor
                out lastWrite);
            if (r != 0) return "query-err=" + r;
            // A FILETIME tick and a .NET tick are both 100 ns - dividing by 10 lands the key in 1643.
            return new DateTime(1601, 1, 1).AddTicks(lastWrite).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
        } catch (Exception e) { return "NO-RUN:" + e.GetType().Name; }
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegQueryInfoKeyW")]
    static extern int RegQueryInfoKeyW(IntPtr hKey, IntPtr lpClass, IntPtr lpcClass, IntPtr lpReserved,
        IntPtr lpcSubkeys, IntPtr lpcMaxSubKeyLen, IntPtr lpcMaxClassLen, IntPtr lpcValues,
        IntPtr lpcMaxValueNameLen, IntPtr lpcMaxValueLen, IntPtr lpcbSecurityDescriptor, out long lpftLastWrite);

    /// Explorer keeps an explicit order/visibility list of icon ids (8 bytes each, little-endian u64)
    /// in the parent key. Membership separates "explorer knows this icon" from "explorer dropped it",
    /// which the per-icon key alone cannot tell you.
    public static string UiOrderList(string exeFragment) {
        using (RegistryKey root = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings")) {
            if (root == null) return "NO-RUN: parent key missing";
            byte[] data = root.GetValue("UIOrderList") as byte[];
            if (data == null) return "NO-RUN: UIOrderList value missing (older Windows?)";
            List<string> ids = new List<string>();
            for (int i = 0; i + 8 <= data.Length; i += 8) ids.Add(BitConverter.ToUInt64(data, i).ToString());
            StringBuilder sb = new StringBuilder();
            sb.Append("UIOrderList bytes=" + data.Length + " entries=" + ids.Count);
            string[] names = root.GetSubKeyNames();
            int matched = 0;
            foreach (string name in names) {
                RegistryKey k = root.OpenSubKey(name);
                if (k == null) continue;
                string exe = Convert.ToString(k.GetValue("ExecutablePath", ""));
                k.Close();
                if (exeFragment.Length > 0 && exe.IndexOf(exeFragment, StringComparison.OrdinalIgnoreCase) < 0) continue;
                matched++;
                sb.Append("\n  id=" + name + " inOrderList=" + (ids.IndexOf(name) >= 0) + " exe=" + exe);
            }
            if (matched == 0) sb.Append("\n  (no key matched the exe filter)");
            return sb.ToString();
        }
    }

    static string SnapInfo(object snap) {        byte[] b = snap as byte[];
        if (b == null) return "none";
        string dims = "";
        if (b.Length > 24 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) {
            int w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
            int h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
            dims = " png=" + w + "x" + h;
        } else if (b.Length > 20 && b[0] == 0 && b[1] == 0 && b[2] == 1) {
            dims = " ico=" + b[6] + "x" + (b[7] == 0 ? 256 : b[7]);
        } else {
            dims = " fmt=?";
        }
        return "bytes=" + b.Length + dims;
    }
}
'@

if (-not ('TrayProbe' -as [type])) {
    Add-Type -TypeDefinition $script:TrayProbeSource -Language CSharp -WarningAction SilentlyContinue -ErrorAction Stop
}
