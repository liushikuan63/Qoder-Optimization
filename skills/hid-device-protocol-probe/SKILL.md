---
name: hid-device-protocol-probe
description: "Windows 上不用厂商软件、从 PowerShell 探 USB HID 收发通路——用 SetupAPI 加 HidP_GetCaps 枚举每个 collection 的 UsagePage 与 Usage 及报告长度找厂商命令通道；用 joyGetPosEx 证明手柄真的在；读写各放可取消工作线程；发只读查询帧按回复直方图区分发不出去与设备答了但客户端收不到。用于手柄、2.4G 接收器、外设配置工具卡在同步转圈且不报错，或 HID P-Invoke 读数离谱如 CreateFile err=123、ReadFile err=87、探针睡死。"
---

# HID Device Protocol Probe

## Overview

Measure the HID send/receive chain directly against the device so a vendor client's vague "syncing forever" collapses into one of three facts: the channel does not exist, the device is not live, or the device answers and the client is the broken half.

Windows only (`hid.dll`, `setupapi.dll`, `kernel32.dll`, `winmm.dll`). PowerShell 5.1, run from any shell.

## When to use

- A controller / dongle / peripheral configuration app is stuck on a sync mask with no error and no timeout.
- P-Invoke against HID produces results that look like "the device is broken": `CreateFile` err=123 on every enumerated path, product string coming back one character long, `ReadFile`/`WriteFile` err=87, `HidD_SetOutputReport` err=31, or a probe that simply never returns.
- `joyGetNumDevs()` says 16 but no slot looks active - decide whether nothing is attached or the probe is lying.
- Need to know whether a vendor channel (UsagePage `0xFF00`-`0xFFFF`, or bare `0xFF`) exists on a given device instance, and its real report lengths.

Not for: device disabled / driver missing (read `Win32_PnPEntity` `Status` and `ConfigManagerErrorCode` first), BLE GATT, UWP `Windows.Devices.HumanInterfaceDevice`, or raw USB descriptor dumps - different layer.

## Rules of engagement

1. **Send only read-only queries.** Reuse a request the client itself sends periodically (read firmware version, read status). Never send config-write, profile-upload or firmware-update frames from a probe - there is no rollback.
2. **Keep `.ps1` bodies ASCII.** PowerShell 5.1 decodes BOM-less files as the ANSI codepage, so Chinese literals get destroyed and the failure looks like a quoting bug. Comments and labels in ASCII, prose in this file.
3. **Never call a synchronous HID API on the main thread.** See Step 3 - this is what turns a probe into a hung process.
4. Do not read concurrent traffic as packet loss. HID allows multiple readers, so while a vendor client runs your probe also sees the client's polls, and the client sees yours.

## Step 1 - Enumerate collections, find the vendor channel

```
powershell -NoProfile -ExecutionPolicy Bypass -File <本机辅助脚本>/hid-enum.ps1 -Filter vid_20bc
```

One line per top-level collection: `[VENDOR|OK|ERRn]`, `UP`/`U` (UsagePage/Usage), `In`/`Out`/`Feat` report byte lengths, VID/PID/rev, product and manufacturer strings, device path. The header line totals the vendor-channel candidates.

- Vendor channel candidate = `UP=0x00FF` or `0xFF00`-`0xFFFF` **and** `Out>0`. Consumer page `0x01` (joystick `U=0x04`, gamepad `U=0x05`, keyboard `U=0x06`, mouse `U=0x02`) is not it.
- Composite controllers expose several siblings (`mi_01&col01..colNN`, `ig_02`). The gamepad interface and the command interface are usually **different instance paths**; the one with `UP=0xFF` is the command channel.
- Record `In` and `Out` - Step 3 sizes its buffers from them.
- Devices can enumerate under an alternate VID in some modes (the reference device shows as `VID_20BC` or `VID_20DD` with the same `PID_5130`). Filter by PID when a VID gives nothing.

Four marshalling traps the bundled script already handles; re-apply them to any variant you write:

| Trap | Symptom | Fix |
|---|---|---|
| `SP_DEVICE_INTERFACE_DETAIL_DATA.DevicePath` offset | every `CreateFile` gives **err=123** (`ERROR_INVALID_NAME`) and the printed path starts `?hid#` instead of `\\?\hid#` | On x64 the path begins at **byte offset 4**, not 8 (`cbSize` is a 4-byte DWORD under Pack=2 alignment). `Marshal.PtrToStringUni(ptr + 4)`. Keep setting `cbSize = 8` on x64, `4 + sizeof(Guid)` on x86. |
| `CharSet` on `HidD_Get*String` | one-character product and manufacturer strings | Declare them `CharSet=CharSet.Unicode` and pass a `StringBuilder`. The default ANSI marshaler reads the wide string byte-wise and stops at the first NUL. |
| Handle rights | some interfaces need elevation | `CreateFile(path, 0, 3, ...)` (access 0, share read+write) is enough for `HidD_GetAttributes`, `HidD_GetPreparsedData`, `HidP_GetCaps`. Don't ask for generic read/write just to read caps. |
| Path passed through MSYS/Git Bash | `\\?\hid#...` arrives as `\?\hid#...` and fails err=123 even when correct | Prefer `-Select <substring>` on the probe scripts; they enumerate and resolve the path in-process. If you must pass `-Path`, expect one backslash pair to disappear. |

## Step 2 - Prove the device is live (do not trust the first result)

```
powershell -NoProfile -ExecutionPolicy Bypass -File <本机辅助脚本>/joy-check.ps1 -VidPattern 'VID_20BC'
```

Uses `joyGetPosEx` with `dwSize` and `dwFlags` set before the call, and **prints every slot's return code**. `rc=0` with centred X/Y is proof of a live, reporting controller.

- **Never use `joyGetDevCaps` for liveness.** Its capability struct marshals silently wrong, so every slot looks dead while `joyGetNumDevs()` still reports 16. This false negative produced a wrong "nothing connected" conclusion in the source session.
- `rc=165` = `JOYERR_PARMS` (0xA5) = empty slot, normal past the last real device. All slots non-zero **while the PnP section shows `status=OK`** means the probe is lying, not the hardware.
- The script also dumps the PnP live state and two "ever attached" histories (`...\PrivateProperties\Joystick\OEM` and `HKLM\...\Enum\USB`). **A PID missing from both has never been connected** - that is frequently the whole answer, see Step 5.

## Step 3 - Round trip: send a read-only query, capture replies

```
powershell -NoProfile -ExecutionPolicy Bypass -File <本机辅助脚本>/hid-rw-probe.ps1 \
  -Select 'vid_20dd&pid_5130' -PayloadHex 0255 -WindowMs 2500
```

Omit `-PayloadHex` for a pure passive listen (nothing is written, handle opened read-only). `-PayloadHex` must already include the report ID as byte 0, exactly as the app's own frame does; it is padded to `Out`.

| Error / shape | Meaning | Action |
|---|---|---|
| Probe never returns, has to be killed | A synchronous HID call blocks indefinitely on a sleeping, powered-down or held device, and **a pending call also pins `CloseHandle`** - so even closing the handle hangs | Run reads and writes on worker threads and call `CancelSynchronousIo(OpenThread(SYNCHRONIZE or TERMINATE, GetCurrentThreadId()))` before closing. The cancelled read reports **err=995** (`ERROR_IO_PENDING`; 1223 on some builds). |
| `WriteFile` stuck with no completion line, WARNING printed | The device is not servicing this handle at all (asleep / unplugged / exclusive hold) | Inconclusive. Wake the device (press a button, or start the vendor client so it wakes the link) and retry. Do not report "device dead". |
| `ReadFile`/`WriteFile` err=87 right after opening | Handle opened with `FILE_FLAG_OVERLAPPED` but called synchronously, or buffer length is not the caps length | Open with `flags = 0` for synchronous calls (or use a real `OVERLAPPED` for async), and size buffers from `In`/`Out`. |
| `HidD_SetOutputReport` err=31 (`ERROR_NOT_SUPPORTED`) | The driver does not support the ioctl output-report path. Expected when `Out=0`, **and also observed on a collection reporting `Out=64`**; this is additionally the call most prone to blocking | Fall back to `WriteFile` before concluding anything. The script keeps this ioctl behind `-TrySetOutputReport` for exactly that reason. |
| `WriteFile` err=87 on the ID-stripped variant | Byte 0 of the buffer must be the report ID | Expected; `-ProbeIdStripped` exists to prove it on a device, not as a send path. |
| `CreateFile` err=5 | Another holder is exclusive, or the interface needs elevation | Note it; vendor tools often run elevated and a non-elevated probe cannot read their modules either. |
| `CreateFile` err=123 | Path corrupt | Offset trap or MSYS backslash loss - see Step 1. |
| `SKIPPED SEND: Out=0` | That collection takes no output reports; the frame was **not** sent | Switch to the sibling collection with `Out>0`. |

Output is deduped: `replies total=N distinct=M`, up to `-MaxDistinct` distinct frames with repeat counts, then a `reply kinds` histogram over `report id + byte1` (byte1 is usually the command). Read the histogram, never the raw stream - a heartbeat device emits 20+ identical frames per second.

## Step 4 - Classify the failure (the payoff)

1. **No reply, write failed** - send path dead: wrong collection, wrong report length, or handle/flag error. Fix Step 3 before blaming the device.
2. **No reply, write succeeded** - the device is not accepting that frame, or it answers on a different collection. Re-run against siblings.
3. **Correct reply to your query** - protocol, channel and device are healthy. If the vendor client still spins, **the fault is in the client's receive path**. Confirm with a passive listen: the reply kinds the client needs never appear while heartbeat kinds (status, ping) stream normally.
4. **Device answers your hand-built frame, but the client's own frame never appears** - the client is not sending it, or its reader is bound to a different device instance. Go to Step 5.

Distinguish "device never answers" from "client never asks" by sending the client's own frame yourself. A correct reply to your own frame is decisive evidence the protocol stack is fine.

## Step 5 - Vendor client bound to the wrong device instance

When Step 4 lands on case 3 or 4, look at how the client registers devices instead of theorising about dead threads:

1. Unpack the client's resources (Electron: `resources/app.asar`, e.g. `npx @electron/asar extract`) and grep its device script for registration calls. Names vary, the shape does not: `RegisterDev2(vid, pid, ...)`, `RegisterAlterDev(...)`, `SetUseDevPath`, `InitThreads`. To read code inside a packed asar without unpacking it, use the `electron-asar-code-forensics` skill; to decide which layer a forever-spinner is waiting on before touching HID, use `electron-app-stuck-spinner-triage`.
2. Compare the registered PIDs against what Step 1 actually enumerated. **A primary registration plus a secondary/alternate entry is the tell.** If the primary is the *wired* PID and only a dongle PID is present, the receive pump is bound to an instance that does not exist: writes still land on the dongle, the device still answers, and replies never reach the callback. Vendor UI text usually admits it somewhere - "connect with a data cable" for sync and upgrade operations.
3. Corroborate with Step 2's attach history: a wired PID absent from both lists means the user has only ever run wireless.
4. Remedy to hand back: connect the device over a **data** cable (charge-only cables are the standard trap), sync/write, then return to wireless. Firmware upgrade and similar operations typically stay wired-only.

Reference case, verified end to end: Betop KP70 (BTP-KP70A). `PID_5130` = 2.4G dongle, `PID_512F` = wired gamepad, code registered `RegisterDev2(0x20bc, 0x512f, ...)` as primary plus `RegisterAlterDev(0x20bc, 0x5130, ..., 0)` as alternate. Vendor channel `mi_01&col01` with `UP=0xFF U=0x03 In=64 Out=64`. Frame `[0x02][0x55]` answered `02 55 01 02 00 01`; `[0x02][0x11][0x00][0x10]` answered `02 11 00 10 00 8c 32 e7` immediately, while the passive stream carried only `0x15` status and `0x21` ping - never `0x11`. Wired connection fixed the sync.

## Wrong turns on record

- **"The client's HID receive thread died, restart it."** Restart and replug both changed nothing. "Can send, cannot receive" is also exactly what an instance-registration mismatch looks like - check Step 5 before promising a restart.
- **"No controller is connected."** From `joyGetNumDevs=16` with zero active slots - a `joyGetDevCaps` artifact (Step 2).
- **"Every device is busy / access denied."** Was err=123 from reading `DevicePath` at offset 8 (Step 1).
- **"The device reports junk strings."** Was a missing `CharSet.Unicode` (Step 1).
- **"The probe hung, so the device is broken."** The probe itself was the hazard: an uncancellable synchronous write on a sleeping device pins the process (Step 3).

## Validate the probe itself

A probe that silently reports "no replies" is worse than the bug being chased. Run all five controls; each one can fail.

1. **Wiring control** - `-Path` a deliberately corrupt path, expect `CreateFile FAILED err=123` (or 2). Proves the parameter reaches the API.
2. **Ambiguity control** - `-Select` a substring matching several collections, expect a refusal plus the candidate list, never a guess.
3. **Negative control** - `-Select` a collection with `Out=0` and pass `-PayloadHex`; expect `SKIPPED SEND` and **no bytes on the wire**. A script that prints nothing here is swallowing failures.
4. **Hang control** - `-Select` a sleeping device with `-PayloadHex` and `-TrySetOutputReport`; the process must exit within roughly `2 x WindowMs` and print the WARNING. If it has to be killed, the cancellation path is broken.
5. **Positive control** - a read-only query on an awake vendor channel must show a non-zero reply count and the expected kind. Zero replies with `ok=True` on the write line means the read side is broken; zero replies with the WARNING means the device never took the write, which is a different conclusion.

Always report the write line's return code together with the reply count - a reply count alone is unverifiable. If the hardware is asleep and no positive control is reachable, say so explicitly instead of implying the round trip was proven.

## Resources

- `<本机辅助脚本>/hid-enum.ps1` - `-Filter` (case-insensitive substring of the device path). Prints caps, strings, paths, and the vendor-candidate count. Handles the offset-4 and `CharSet.Unicode` traps.
- `<本机辅助脚本>/joy-check.ps1` - `-Slots`, `-VidPattern`, `-MaxPnp`. `joyGetPosEx` with per-slot return codes plus a VERDICT line, PnP live state, and the ever-attached VID/PID histories.
- `<本机辅助脚本>/hid-rw-probe.ps1` - `-Path` or `-Select` (Select resolves in-process, preferred from Git Bash), `-PayloadHex` (omit for passive listen), `-ReportLen` (0 = derive from caps), `-WindowMs`, `-PreMs`, `-MaxDistinct`, `-TrySetOutputReport` (opt-in ioctl), `-ProbeIdStripped`. Reads and writes both run on `CancelSynchronousIo`-cancellable threads; output is deduped with a reply-kind histogram.