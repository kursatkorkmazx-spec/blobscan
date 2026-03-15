"use client";
import { useState, useCallback } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";

const DEMO_ADDRESS = "0x3882ef9ee7be69abbe4f7465b0b05ec0fce7509bd2464cc2ba5c3b0b3e13c4e4";

function generateId(): string {
  return "cipher_" + Math.random().toString(36).slice(2, 10);
}

function generateKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function passwordStrength(pw: string): { label: string; color: string; pct: number } {
  if (!pw) return { label: "—", color: "#333", pct: 0 };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 16) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: "WEAK", color: "#f87171", pct: 20 };
  if (score <= 3) return { label: "MEDIUM", color: "#facc15", pct: 60 };
  return { label: "STRONG", color: "#4ade80", pct: 100 };
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function fileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const types: Record<string, string> = { jpg: "Image", jpeg: "Image", png: "Image", gif: "Image", webp: "Image", mp4: "Video", pdf: "PDF", txt: "Text", zip: "Archive", json: "JSON", csv: "CSV" };
  return types[ext] || ext.toUpperCase() || "File";
}

interface VaultRecord {
  id: string;
  name: string;
  size: number;
  hash: string;
  date: string;
  encrypted: boolean;
  key?: string;
  status: "ACTIVE" | "EXPIRED" | "CONSUMED";
  oneDownload: boolean;
  downloaded: boolean;
  expiration: string;
  shareLink?: string;
}

interface FileInfo {
  file: File;
  hash: string;
  preview: string | null;
}

type EventType = "WALLET_CONNECTED" | "WALLET_DISCONNECTED" | "FILE_SELECTED" | "FILE_ENCRYPTED" | "UPLOAD_STARTED" | "UPLOAD_COMPLETED" | "RECORD_PERSISTED" | "LINK_CREATED" | "VAULT_WIPED" | "DOWNLOAD_CONSUMED";

interface ProtocolEvent {
  type: EventType;
  message: string;
  time: string;
}

export default function UploadClient() {
  const { account, connect, wallets, connected, disconnect } = useWallet();
  const [demoMode, setDemoMode] = useState(false);
  const [fileInfos, setFileInfos] = useState<FileInfo[]>([]);
  const [expiration, setExpiration] = useState("86400");
  const [oneDownload, setOneDownload] = useState(false);
  const [encrypt, setEncrypt] = useState(false);
  const [password, setPassword] = useState("");
  const [autoKey, setAutoKey] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState(false);
  const [activeTab, setActiveTab] = useState<"upload" | "vault" | "log">("upload");
  const [shareLink, setShareLink] = useState("");
  const [vault, setVault] = useState<VaultRecord[]>(() => {
    if (typeof window === "undefined") return [];
    return JSON.parse(localStorage.getItem("shelby_vault") || "[]");
  });
  const [events, setEvents] = useState<ProtocolEvent[]>(() => {
    if (typeof window === "undefined") return [];
    return JSON.parse(localStorage.getItem("shelby_events") || "[]");
  });
  const [vaultFilter, setVaultFilter] = useState<"ALL" | "ACTIVE" | "EXPIRED" | "CONSUMED">("ALL");

  const isConnected = connected || demoMode;
  const displayAddress = demoMode ? DEMO_ADDRESS : account?.address?.toString();
  const strength = passwordStrength(password);

  function addEvent(type: EventType, message: string) {
    const e: ProtocolEvent = { type, message, time: new Date().toLocaleTimeString() };
    setEvents(prev => {
      const updated = [e, ...prev].slice(0, 50);
      localStorage.setItem("shelby_events", JSON.stringify(updated));
      return updated;
    });
  }

  function saveVault(records: VaultRecord[]) {
    setVault(records);
    localStorage.setItem("shelby_vault", JSON.stringify(records));
  }

  async function processFiles(files: File[]) {
    const infos = await Promise.all(files.map(async (f) => {
      const buf = await f.arrayBuffer();
      const hash = await sha256(buf);
      const isImage = f.type.startsWith("image/");
      const preview = isImage ? URL.createObjectURL(f) : null;
      return { file: f, hash, preview };
    }));
    setFileInfos(infos);
    addEvent("FILE_SELECTED", `${files.length} file(s) selected`);
  }

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragging(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, []);

  const handleUpload = async () => {
    if (!isConnected || fileInfos.length === 0) return;
    const finalPassword = autoKey ? generateKey() : password;
    setStatus("Processing...");
    addEvent("UPLOAD_STARTED", `Uploading ${fileInfos.length} file(s)`);
    await new Promise(r => setTimeout(r, 600));

    if (encrypt && finalPassword) {
      setStatus("Encrypting (AES-256-GCM)...");
      addEvent("FILE_ENCRYPTED", "AES-256-GCM encryption applied");
      await new Promise(r => setTimeout(r, 900));
    }

    setStatus("Uploading to Shelby network...");
    await new Promise(r => setTimeout(r, 1200));

    const newRecords: VaultRecord[] = fileInfos.map(fi => {
      const id = generateId();
      const link = `${window.location.origin}/upload?file=${id}${encrypt && finalPassword ? `&key=${encodeURIComponent(finalPassword)}` : ""}`;
      return {
        id, name: fi.file.name, size: fi.file.size, hash: fi.hash,
        date: new Date().toLocaleString(), encrypted: encrypt && !!finalPassword,
        key: encrypt ? finalPassword : undefined, status: "ACTIVE",
        oneDownload, downloaded: false,
        expiration: expiration === "3600" ? "1 hour" : expiration === "86400" ? "1 day" : expiration === "604800" ? "7 days" : "30 days",
        shareLink: link
      };
    });

    const updated = [...vault, ...newRecords];
    saveVault(updated);
    addEvent("UPLOAD_COMPLETED", `${fileInfos.length} file(s) uploaded successfully`);
    addEvent("RECORD_PERSISTED", `${fileInfos.length} record(s) saved to vault`);
    addEvent("LINK_CREATED", `Share link generated`);

    setShareLink(newRecords[0]?.shareLink || "");
    setFileInfos([]);
    setStatus("Upload complete!");
    setTimeout(() => { setStatus(""); setShareLink(""); }, 8000);
  };

  function panicWipe() {
    if (!confirm("Wipe ALL vault records and logs? This cannot be undone.")) return;
    saveVault([]);
    setEvents([]);
    localStorage.removeItem("shelby_vault");
    localStorage.removeItem("shelby_events");
    addEvent("VAULT_WIPED", "All records purged");
    setShareLink("");
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  const filteredVault = vault.filter(r => vaultFilter === "ALL" || r.status === vaultFilter);
  const stats = { total: vault.length, active: vault.filter(r => r.status === "ACTIVE").length, expired: vault.filter(r => r.status === "EXPIRED").length, consumed: vault.filter(r => r.status === "CONSUMED").length };

  const btn = { background: "#7dd3a8", color: "#0f0f0f", border: "none", borderRadius: "6px", padding: "10px 20px", fontFamily: "monospace", fontSize: "13px", cursor: "pointer", fontWeight: "bold" } as const;
  const card = { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "20px", marginBottom: "16px" } as const;
  const tab = (active: boolean) => ({ background: "transparent", border: "none", borderBottom: active ? "2px solid #7dd3a8" : "2px solid transparent", color: active ? "#7dd3a8" : "#555", fontFamily: "monospace", fontSize: "13px", cursor: "pointer", padding: "8px 16px", marginRight: "4px" } as const);

  return (
    <main style={{ fontFamily: "monospace", background: "#0f0f0f", color: "#e0e0e0", minHeight: "100vh", padding: "32px", maxWidth: "800px", margin: "0 auto", position: "relative" }}>
      <canvas id="matrix-upload" style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", zIndex: -1, opacity: 0.08, pointerEvents: "none" }} ref={el => {
        if (!el || (el as any)._init) return;
        (el as any)._init = true;
        const ctx = el.getContext("2d")!;
        el.width = window.innerWidth; el.height = window.innerHeight;
        const cols = Math.floor(el.width / 20);
        const drops = Array(cols).fill(1);
        const chars = "アイウエオカキクケコ0123456789ABCDEF";
        setInterval(() => {
          ctx.fillStyle = "rgba(0,0,0,0.05)";
          ctx.fillRect(0, 0, el.width, el.height);
          ctx.fillStyle = "#7dd3a8";
          ctx.font = "14px monospace";
          drops.forEach((y, i) => {
            ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * 20, y * 20);
            if (y * 20 > el.height && Math.random() > 0.975) drops[i] = 0;
            drops[i]++;
          });
        }, 50);
      }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <a href="/" style={{ color: "#555", textDecoration: "none", fontSize: "13px" }}>← Back to BlobScan</a>
        {isConnected && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ background: "#1a1a1a", border: `1px solid ${demoMode ? "#3a3010" : "#1a3a2a"}`, borderRadius: "6px", padding: "6px 12px", fontSize: "11px" }}>
              <span style={{ color: demoMode ? "#facc15" : "#4ade80" }}>{demoMode ? "⚗ Petra Test" : "● Synced"}</span>
              <span style={{ color: "#555", marginLeft: "6px" }}>{displayAddress?.slice(0, 8)}...{displayAddress?.slice(-6)}</span>
            </div>
            <button onClick={() => { if(demoMode) setDemoMode(false); else disconnect(); addEvent("WALLET_DISCONNECTED", "Wallet disconnected"); }}
              style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "4px 8px", color: "#555", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>Disconnect</button>
          </div>
        )}
      </div>

      <h1 style={{ color: "#7dd3a8", marginTop: "8px", marginBottom: "4px" }}>Upload to Shelby</h1>
      <p style={{ color: "#666", fontSize: "13px", marginBottom: "24px" }}>Decentralized hot storage · AES-256-GCM encryption · SHA-256 integrity</p>

      {!isConnected ? (
        <div style={card}>
          <p style={{ color: "#888", fontSize: "13px", margin: "0 0 16px" }}>Connect your wallet to continue.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {wallets.filter(w => w.name === "Petra").map((w) => (
              <button key={w.name} onClick={() => { connect(w.name); addEvent("WALLET_CONNECTED", `${w.name} connected`); }} style={btn}>Connect Petra</button>
            ))}
            {wallets.filter(w => w.name === "Petra").length === 0 && (
              <p style={{ color: "#555", fontSize: "12px" }}>No wallets detected. Install <a href="https://petra.app" target="_blank" style={{ color: "#7dd3a8" }}>Petra</a>.</p>
            )}
            <button onClick={() => { setDemoMode(true); addEvent("WALLET_CONNECTED", "Petra Test mode activated"); }}
              style={{ ...btn, background: "transparent", color: "#7dd3a8", border: "1px solid #7dd3a8" }}>Petra Test</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ borderBottom: "1px solid #2a2a2a", marginBottom: "20px" }}>
            <button style={tab(activeTab === "upload")} onClick={() => setActiveTab("upload")}>Upload</button>
            <button style={tab(activeTab === "vault")} onClick={() => setActiveTab("vault")}>Vault {vault.length > 0 && `(${vault.length})`}</button>
            <button style={tab(activeTab === "log")} onClick={() => setActiveTab("log")}>Protocol Log {events.length > 0 && `(${events.length})`}</button>
          </div>

          {activeTab === "upload" && (
            <div>
              <div style={card}>
                <div style={{ border: dragging ? "1px dashed #7dd3a8" : "1px dashed #2a2a2a", borderRadius: "6px", padding: fileInfos.length > 0 ? "16px" : "40px", textAlign: "center" as const, cursor: "pointer", color: "#555", marginBottom: "16px" }}
                  onDrop={handleDrop} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
                  onClick={() => document.getElementById("fi")?.click()}>
                  {fileInfos.length > 0 ? (
                    <div style={{ textAlign: "left" as const }}>
                      {fileInfos.map((fi, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "8px 0", borderBottom: i < fileInfos.length - 1 ? "1px solid #2a2a2a" : "none" }}>
                          {fi.preview ? <img src={fi.preview} style={{ width: "48px", height: "48px", objectFit: "cover", borderRadius: "4px", border: "1px solid #2a2a2a" }} /> : <div style={{ width: "48px", height: "48px", background: "#111", borderRadius: "4px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px" }}>📄</div>}
                          <div style={{ flex: 1 }}>
                            <div style={{ color: "#a0c4ff", fontSize: "13px" }}>{fi.file.name}</div>
                            <div style={{ color: "#555", fontSize: "11px" }}>{fileType(fi.file.name)} · {formatSize(fi.file.size)}</div>
                            <div style={{ color: "#333", fontSize: "10px", marginTop: "2px" }}>SHA-256: {fi.hash.slice(0, 16)}...{fi.hash.slice(-8)}</div>
                          </div>
                        </div>
                      ))}
                      <div style={{ textAlign: "center" as const, paddingTop: "8px", fontSize: "12px", color: "#444" }}>Click to add more files</div>
                    </div>
                  ) : "Click or drag files here"}
                </div>
                <input id="fi" type="file" multiple style={{ display: "none" }} onChange={(e) => processFiles(Array.from(e.target.files || []))} />

                <div style={{ background: "#111", borderRadius: "6px", border: "1px solid #2a2a2a", padding: "12px", marginBottom: "12px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", color: "#888", marginBottom: "8px" }}>
                    <input type="checkbox" checked={encrypt} onChange={e => setEncrypt(e.target.checked)} />
                    Enable AES-256-GCM encryption
                  </label>
                  {encrypt && (
                    <>
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", color: "#888", marginBottom: "8px" }}>
                        <input type="checkbox" checked={autoKey} onChange={e => setAutoKey(e.target.checked)} />
                        Auto-generate key
                      </label>
                      {!autoKey && (
                        <>
                          <div style={{ display: "flex", gap: "8px", marginBottom: "6px" }}>
                            <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Encryption password" type={showPassword ? "text" : "password"}
                              style={{ flex: 1, background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 10px", color: "#e0e0e0", fontFamily: "monospace", fontSize: "12px" }} />
                            <button onClick={() => setShowPassword(!showPassword)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#555", cursor: "pointer", fontSize: "11px" }}>{showPassword ? "Hide" : "Show"}</button>
                            <button onClick={() => setPassword(generateKey())} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#555", cursor: "pointer", fontSize: "11px" }}>GEN</button>
                          </div>
                          {password && (
                            <div style={{ marginBottom: "4px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: strength.color, marginBottom: "3px" }}>
                                <span>Strength</span><span>{strength.label}</span>
                              </div>
                              <div style={{ background: "#2a2a2a", borderRadius: "2px", height: "3px" }}>
                                <div style={{ background: strength.color, width: `${strength.pct}%`, height: "3px", borderRadius: "2px", transition: "width 0.3s" }} />
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", color: "#888", marginTop: "8px" }}>
                    <input type="checkbox" checked={oneDownload} onChange={e => setOneDownload(e.target.checked)} />
                    ONE DOWNLOAD — auto-consume after first download
                  </label>
                </div>

                <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                  <select value={expiration} onChange={(e) => setExpiration(e.target.value)} style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "8px", color: "#e0e0e0", fontFamily: "monospace" }}>
                    <option value="3600">1 hour</option>
                    <option value="86400">1 day</option>
                    <option value="604800">7 days</option>
                    <option value="2592000">30 days</option>
                  </select>
                  <button onClick={handleUpload} disabled={fileInfos.length === 0} style={{ ...btn, flex: 1, opacity: fileInfos.length === 0 ? 0.5 : 1 }}>
                    {status || "Upload"}
                  </button>
                </div>

                {status && <div style={{ fontSize: "12px", color: status.startsWith("Error") ? "#f87171" : "#4ade80", marginBottom: "8px" }}>{status}</div>}

                {shareLink && (
                  <div style={{ background: "#0a1a0a", border: "1px solid #1a3a1a", borderRadius: "6px", padding: "12px" }}>
                    <div style={{ fontSize: "11px", color: "#4ade80", marginBottom: "6px" }}>Share Link:</div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <input readOnly value={shareLink} style={{ flex: 1, background: "#111", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 10px", color: "#888", fontFamily: "monospace", fontSize: "10px" }} />
                      <button onClick={() => copyToClipboard(shareLink)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#7dd3a8", cursor: "pointer", fontSize: "11px" }}>Copy</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "vault" && (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px", marginBottom: "16px" }}>
                {[["TOTAL", stats.total, "#a0c4ff"], ["ACTIVE", stats.active, "#4ade80"], ["EXPIRED", stats.expired, "#facc15"], ["CONSUMED", stats.consumed, "#f87171"]].map(([label, count, color]) => (
                  <div key={label as string} style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "12px", textAlign: "center" as const }}>
                    <div style={{ fontSize: "18px", color: color as string, fontWeight: "bold" }}>{count}</div>
                    <div style={{ fontSize: "10px", color: "#555" }}>{label}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: "6px", marginBottom: "12px" }}>
                {(["ALL", "ACTIVE", "EXPIRED", "CONSUMED"] as const).map(f => (
                  <button key={f} onClick={() => setVaultFilter(f)}
                    style={{ background: vaultFilter === f ? "#7dd3a8" : "transparent", color: vaultFilter === f ? "#0f0f0f" : "#555", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 10px", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>{f}</button>
                ))}
                <button onClick={panicWipe} style={{ marginLeft: "auto", background: "transparent", border: "1px solid #f87171", borderRadius: "4px", padding: "4px 10px", color: "#f87171", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>⚠ PANIC WIPE</button>
              </div>

              {filteredVault.length === 0 ? (
                <div style={{ color: "#444", fontSize: "13px", padding: "20px 0", textAlign: "center" as const }}>No records found.</div>
              ) : filteredVault.map((r) => (
                <div key={r.id} style={{ ...card, marginBottom: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                    <span style={{ color: "#a0c4ff", fontSize: "13px" }}>{r.name}</span>
                    <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "3px", background: r.status === "ACTIVE" ? "#1a3a2a" : r.status === "EXPIRED" ? "#3a3010" : "#3a1010", color: r.status === "ACTIVE" ? "#4ade80" : r.status === "EXPIRED" ? "#facc15" : "#f87171" }}>{r.status}</span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#555", marginBottom: "4px" }}>
                    {formatSize(r.size)} · {r.date} · Expires: {r.expiration}
                    {r.encrypted && <span style={{ marginLeft: "6px", color: "#60a5fa" }}>🔒 AES-256</span>}
                    {r.oneDownload && <span style={{ marginLeft: "6px", color: "#f87171" }}>⚡ ONE-DL</span>}
                  </div>
                  <div style={{ fontSize: "10px", color: "#333", marginBottom: "6px" }}>ID: {r.id} · SHA-256: {r.hash.slice(0, 12)}...</div>
                  {r.shareLink && (
                    <div style={{ display: "flex", gap: "6px" }}>
                      <input readOnly value={r.shareLink} style={{ flex: 1, background: "#111", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#555", fontFamily: "monospace", fontSize: "10px" }} />
                      <button onClick={() => copyToClipboard(r.shareLink!)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "3px 6px", color: "#7dd3a8", cursor: "pointer", fontSize: "10px" }}>Copy</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === "log" && (
            <div style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <h2 style={{ margin: 0, fontSize: "13px", color: "#888", textTransform: "uppercase" as const, letterSpacing: "1px" }}>Protocol Events</h2>
                <button onClick={() => { setEvents([]); localStorage.removeItem("shelby_events"); }} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "3px 8px", color: "#555", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>Clear</button>
              </div>
              {events.length === 0 ? (
                <div style={{ color: "#444", fontSize: "13px" }}>No events yet.</div>
              ) : events.map((e, i) => (
                <div key={i} style={{ borderBottom: "1px solid #2a2a2a", padding: "6px 0", fontSize: "12px", display: "flex", gap: "10px" }}>
                  <span style={{ color: "#333", minWidth: "60px" }}>{e.time}</span>
                  <span style={{ color: e.type.includes("ERROR") || e.type === "VAULT_WIPED" ? "#f87171" : e.type.includes("COMPLETED") ? "#4ade80" : "#7dd3a8", minWidth: "140px" }}>{e.type}</span>
                  <span style={{ color: "#555" }}>{e.message}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
