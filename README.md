# IRON ID Sovereign Mail Workspace

Consolidated, self-contained environment for the **IRON ID Mail Engine & Webmail UI**, utilizing the native **IRON ID Sovereign Mail Engine (Rust)** over RFC 8620 / RFC 8621 JMAP protocol with zero-hop intra-server delivery.

---

## Workspace Structure

```
iron-id-workspace/
├── engine/                      # IRON ID Core Mail Engine (Rust) & PostgreSQL / Data Store
│   ├── stalwart.exe             # Core Engine binary (Windows x86_64)
│   ├── config.json              # Relational store configuration pointer
│   ├── config.toml              # Engine TOML configuration reference
│   └── data/                    # Data directory containing accounts & mailboxes
├── webmail/                     # Frontend Client & JMAP Gateway
│   ├── server.js                # Node.js transparent proxy & SPA webmail UI
│   └── package.json             # Service definition
├── docs/                        # Specifications, Reports & Briefs
│   ├── ANTIGRAVITY_SPEC.md      # Integration specification
│   ├── IRON_ID_Group_Partner_Brief.pdf
│   └── IRON_ID_Sovereign_Mail_Full_Project_Report.pdf
├── start-all.bat                # 1-click batch launcher
├── start-all.ps1                # 1-click PowerShell launcher
└── README.md                    # Workspace guide
```

---

## Verified User Directory

| User | Email | Password | Account ID | Identity ID |
| :--- | :--- | :--- | :--- | :--- |
| **Tenant Primary** | `charaf@iron-id.io` | `Ch@r@firon-!D` | `c` | `b` |
| **Client / Tenant** | `anis@client.dz` | `anistestmail` | `e` | `d` |

---

## How to Run

### Option 1: 1-Click Launcher
Double-click `start-all.bat` (or run `start-all.ps1` in PowerShell). This launches both the IRON ID Engine and the Webmail client, then opens `http://localhost:3001` in your browser.

### Option 2: Manual Start

**Step 1: Start IRON ID Core Engine**
```powershell
cd engine
.\stalwart.exe -c config.json
```
*Note: The `-c` flag requires the store JSON config (`config.json`), which configures the underlying data store.*

**Step 2: Start Webmail Gateway**
```powershell
cd ..\webmail
node server.js
```

**Step 3: Open in Browser**
Navigate to [http://localhost:3001](http://localhost:3001).

---

## Key Features & Fixes Included

1. **Full Folder Navigation**: View Inbox, Sent, Drafts, Trash with live message counts.
2. **Proper Sent Mailbox Routing**: Outgoing emails are stored in the user's **Sent** folder rather than being dumped into Inbox.
3. **Zero-Hop Atomic Submission**: Uses RFC 8621 `Email/set` + `EmailSubmission/set` with `#msg1` backreferencing.
4. **Account Switching**: Switch between `charaf@iron-id.io` and `anis@client.dz` directly from the top navigation.
5. **Modern Sleek Aesthetics**: Dark mode sovereign theme styled with Tailwind CSS, custom scrollbars, and instant previewing.
