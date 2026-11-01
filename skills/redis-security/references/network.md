# Secure Network Access

Restrict network access to Redis to only trusted sources.

Addresses below are documentation-only examples. Replace them with the approved private interface and application-server subnet before use; review firewall changes before applying them.

**Correct:** Bind to specific interfaces.

```
# redis.conf
bind 127.0.0.1 192.0.2.10
protected-mode yes
```

**Correct:** Use firewall rules.

```bash
# Allow only application servers
iptables -A INPUT -p tcp --dport 6379 -s 192.0.2.0/24 -j ACCEPT
iptables -A INPUT -p tcp --dport 6379 -j DROP
```

**Incorrect:** Exposing Redis to the internet.

```
# Bad: Binds to all interfaces
bind 0.0.0.0
protected-mode no
```

**Security checklist:**
- Use TLS for connections
- Bind to specific interfaces, not `0.0.0.0`
- Use firewall rules to restrict access
- Disable dangerous commands in production

```
# Disable dangerous commands
rename-command FLUSHALL ""
rename-command DEBUG ""
rename-command CONFIG ""
```

Reference: [Redis Security](https://redis.io/docs/latest/operate/oss_and_stack/management/security/)
