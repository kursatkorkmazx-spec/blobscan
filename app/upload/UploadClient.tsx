"use client";
import { useState, useCallback } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAccountBlobs } from "@shelby-protocol/react";
import { AccountAddress } from "@aptos-labs/ts-sdk";
import {
  createBlobKey,
  createDefaultErasureCodingProvider,
  expectedTotalChunksets,
  generateCommitments,
  ShelbyBlobClient,
} from "@shelby-protocol/sdk/browser";
import { shelbyClient } from "../shelbyClient";

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

async function encryptData(data: Uint8Array<ArrayBuffer>, password: string): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(data) as unknown as BufferSource);
  // Format: [salt(16)] [iv(12)] [ciphertext]
  const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  result.set(salt, 0);
  result.set(iv, salt.length);
  result.set(new Uint8Array(encrypted), salt.length + iv.length);
  return result;
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
  blobName?: string;
  owner?: string;
}

interface FileInfo {
  file: File;
  hash: string;
  preview: string | null;
}

type EventType = "WALLET_CONNECTED" | "WALLET_DISCONNECTED" | "FILE_SELECTED" | "FILE_ENCRYPTED" | "UPLOAD_STARTED" | "UPLOAD_COMPLETED" | "UPLOAD_FAILED" | "RECORD_PERSISTED" | "LINK_CREATED" | "VAULT_WIPED" | "DOWNLOAD_CONSUMED" | "BLOB_DOWNLOADING" | "BLOB_DOWNLOADED" | "TX_SUBMITTED" | "TX_CONFIRMED" | "BLOB_REGISTERED" | "BLOB_UPLOADED";

interface ProtocolEvent {
  type: EventType;
  message: string;
  time: string;
}

export default function UploadClient() {
  const wallet = useWallet();
  const { account, connect, wallets, connected, disconnect } = wallet;
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

  const [isUploading, setIsUploading] = useState(false);
  const [txHash, setTxHash] = useState("");

  const displayAddress = account?.address?.toString();
  const strength = passwordStrength(password);

  // Query account blobs for vault refresh (may fail without API key)
  const { data: accountBlobs, refetch: refetchBlobs } = useAccountBlobs({
    client: shelbyClient,
    account: displayAddress || "",
    enabled: !!displayAddress,
    retry: false,
  });

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
    if (!connected || !account || fileInfos.length === 0) return;

    const finalPassword = autoKey ? generateKey() : password;
    setStatus("Processing files...");
    setIsUploading(true);
    setTxHash("");
    addEvent("UPLOAD_STARTED", `Uploading ${fileInfos.length} file(s) to Shelby network`);

    try {
      // Calculate expiration in microseconds
      const expirationSeconds = parseInt(expiration);
      const expirationMicros = (Date.now() + expirationSeconds * 1000) * 1000;
      const accountAddress = account.address.toString();

      // Prepare blobs
      const blobsToUpload: { blobName: string; blobData: Uint8Array }[] = [];

      for (const fi of fileInfos) {
        let data = new Uint8Array(await fi.file.arrayBuffer());

        // Encrypt if enabled
        if (encrypt && finalPassword) {
          setStatus(`Encrypting ${fi.file.name} (AES-256-GCM)...`);
          addEvent("FILE_ENCRYPTED", `AES-256-GCM encryption applied to ${fi.file.name}`);
          data = await encryptData(data, finalPassword);
        }

        blobsToUpload.push({
          blobName: fi.file.name,
          blobData: data,
        });
      }

      // Step 1: Check which blobs already exist (try indexer, fallback to register all)
      let blobsToRegister = blobsToUpload;
      try {
        setStatus("Checking existing blobs...");
        const existingBlobs = await shelbyClient.coordination.getBlobs({
          where: {
            blob_name: {
              _in: blobsToUpload.map((blob) =>
                createBlobKey({
                  account: accountAddress,
                  blobName: blob.blobName,
                })
              ),
            },
          },
        });

        blobsToRegister = blobsToUpload.filter(
          (blob) =>
            !existingBlobs.some(
              (existingBlob) =>
                existingBlob.name ===
                createBlobKey({
                  account: accountAddress,
                  blobName: blob.blobName,
                })
            )
        );
      } catch (indexerErr) {
        console.warn("Indexer query failed (API key may be required), registering all blobs:", indexerErr);
        addEvent("BLOB_REGISTERED", "Indexer unavailable, registering all blobs");
      }

      // Step 2: Register new blobs on-chain (this sends the TX!)
      if (blobsToRegister.length > 0) {
        setStatus("Generating erasure coding commitments...");
        addEvent("BLOB_REGISTERED", `Generating commitments for ${blobsToRegister.length} blob(s)`);

        const provider = await createDefaultErasureCodingProvider();
        const blobCommitments = await Promise.all(
          blobsToRegister.map(async (blob) =>
            generateCommitments(provider, blob.blobData)
          )
        );

        const chunksetSize = provider.config.erasure_k * provider.config.chunkSizeBytes;

        setStatus("Waiting for wallet approval...");
        addEvent("TX_SUBMITTED", "Sending register blob transaction via Petra...");

        // This triggers the Petra wallet popup for TX approval!
        const pendingTx = await wallet.signAndSubmitTransaction({
          data: ShelbyBlobClient.createBatchRegisterBlobsPayload({
            account: AccountAddress.from(accountAddress),
            expirationMicros,
            blobs: blobsToRegister.map((blob, index) => ({
              blobName: blob.blobName,
              blobSize: blob.blobData.length,
              blobMerkleRoot: blobCommitments[index].blob_merkle_root,
              numChunksets: expectedTotalChunksets(
                blob.blobData.length,
                chunksetSize
              ),
            })),
            encoding: provider.config.enumIndex,
          }),
        });

        const hash = pendingTx.hash;
        setTxHash(hash);
        addEvent("TX_SUBMITTED", `TX submitted: ${hash}`);

        setStatus("Waiting for TX confirmation...");
        await shelbyClient.coordination.aptos.waitForTransaction({
          transactionHash: hash,
        });

        addEvent("TX_CONFIRMED", `TX confirmed: ${hash}`);
        setStatus("Transaction confirmed! Uploading blob data...");
      } else {
        addEvent("BLOB_REGISTERED", "Blobs already registered on-chain, skipping TX");
      }

      // Step 3: Upload blob data to RPC
      setStatus("Uploading blob data to storage providers...");
      for (const blob of blobsToUpload) {
        addEvent("BLOB_UPLOADED", `Uploading ${blob.blobName} to RPC...`);
        await shelbyClient.rpc.putBlob({
          account: accountAddress,
          blobName: blob.blobName,
          blobData: blob.blobData,
        });
        addEvent("BLOB_UPLOADED", `${blob.blobName} uploaded to storage providers`);
      }

      // Create vault records
      const newRecords: VaultRecord[] = fileInfos.map((fi) => {
        const ownerAddr = accountAddress;
        const link = `${window.location.origin}/?address=${ownerAddr}&blob=${encodeURIComponent(fi.file.name)}${encrypt && finalPassword ? `&key=${encodeURIComponent(finalPassword)}` : ""}`;
        return {
          id: `blob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: fi.file.name,
          size: fi.file.size,
          hash: fi.hash,
          date: new Date().toLocaleString(),
          encrypted: encrypt && !!finalPassword,
          key: encrypt ? finalPassword : undefined,
          status: "ACTIVE" as const,
          oneDownload,
          downloaded: false,
          expiration: expirationSeconds === 3600 ? "1 hour" : expirationSeconds === 86400 ? "1 day" : expirationSeconds === 604800 ? "7 days" : "30 days",
          shareLink: link,
          blobName: fi.file.name,
          owner: ownerAddr,
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

      // Refresh blob list
      refetchBlobs();

      setTimeout(() => { setStatus(""); setShareLink(""); }, 12000);
    } catch (err: any) {
      const msg = err?.message || "Upload failed";
      setStatus(`Error: ${msg}`);
      addEvent("UPLOAD_FAILED", msg);
      console.error("Upload error:", err);
      setTimeout(() => setStatus(""), 8000);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDownloadBlob = async (record: VaultRecord) => {
    if (!record.blobName || !record.owner) return;
    try {
      addEvent("BLOB_DOWNLOADING", `Downloading ${record.name} from Shelby network...`);
      setStatus(`Downloading ${record.name}...`);

      const blob = await shelbyClient.download({
        account: record.owner,
        blobName: record.blobName,
      });

      // Read the stream into a Uint8Array
      const reader = blob.readable.getReader();
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.length;
      }
      let data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }

      // Decrypt if encrypted and key available
      if (record.encrypted && record.key) {
        try {
          const salt = data.slice(0, 16);
          const iv = data.slice(16, 28);
          const ciphertext = data.slice(28);
          const enc = new TextEncoder();
          const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(record.key), "PBKDF2", false, ["deriveKey"]);
          const cryptoKey = await crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["decrypt"]
          );
          const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
          data = new Uint8Array(decrypted);
        } catch {
          addEvent("UPLOAD_FAILED", "Decryption failed - wrong key?");
        }
      }

      // Trigger browser download
      const downloadBlob = new Blob([data]);
      const url = URL.createObjectURL(downloadBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = record.name;
      a.click();
      URL.revokeObjectURL(url);

      addEvent("BLOB_DOWNLOADED", `${record.name} downloaded successfully`);

      // Mark as consumed if oneDownload
      if (record.oneDownload) {
        const updated = vault.map(r =>
          r.id === record.id ? { ...r, status: "CONSUMED" as const, downloaded: true } : r
        );
        saveVault(updated);
        addEvent("DOWNLOAD_CONSUMED", `${record.name} consumed after download`);
      }

      setStatus("");
    } catch (err: any) {
      setStatus(`Error: ${err?.message || "Download failed"}`);
      addEvent("UPLOAD_FAILED", `Download failed: ${err?.message}`);
      setTimeout(() => setStatus(""), 5000);
    }
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
        {connected && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ background: "#1a1a1a", border: "1px solid #1a3a2a", borderRadius: "6px", padding: "6px 12px", fontSize: "11px" }}>
              <span style={{ color: "#4ade80" }}>● Synced</span>
              <span style={{ color: "#555", marginLeft: "6px" }}>{displayAddress?.slice(0, 8)}...{displayAddress?.slice(-6)}</span>
            </div>
            <button onClick={() => { disconnect(); addEvent("WALLET_DISCONNECTED", "Wallet disconnected"); }}
              style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "4px 8px", color: "#555", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>Disconnect</button>
          </div>
        )}
      </div>

      <h1 style={{ color: "#7dd3a8", marginTop: "8px", marginBottom: "4px" }}>Upload to Shelby</h1>
      <p style={{ color: "#666", fontSize: "13px", marginBottom: "24px" }}>Decentralized hot storage · AES-256-GCM encryption · SHA-256 integrity · Real blob uploads</p>

      {!connected ? (
        <div style={card}>
          <p style={{ color: "#888", fontSize: "13px", margin: "0 0 16px" }}>Connect your Petra wallet to upload files to the Shelby network.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {wallets.filter(w => w.name === "Petra").map((w) => (
              <button key={w.name} onClick={() => { connect(w.name); addEvent("WALLET_CONNECTED", `${w.name} connected`); }} style={btn}>Connect Petra</button>
            ))}
            {wallets.filter(w => w.name === "Petra").length === 0 && (
              <p style={{ color: "#555", fontSize: "12px" }}>No wallets detected. Install <a href="https://petra.app" target="_blank" style={{ color: "#7dd3a8" }}>Petra</a>.</p>
            )}
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
                  <button onClick={handleUpload} disabled={fileInfos.length === 0 || isUploading} style={{ ...btn, flex: 1, opacity: fileInfos.length === 0 || isUploading ? 0.5 : 1 }}>
                    {isUploading ? "Uploading to Shelby..." : status || "Upload to Shelby Network"}
                  </button>
                </div>

                {status && <div style={{ fontSize: "12px", color: status.startsWith("Error") ? "#f87171" : "#4ade80", marginBottom: "8px" }}>{status}</div>}

                {txHash && (
                  <div style={{ background: "#0a0a1a", border: "1px solid #1a1a3a", borderRadius: "6px", padding: "12px", marginBottom: "8px" }}>
                    <div style={{ fontSize: "11px", color: "#a0c4ff", marginBottom: "6px" }}>Transaction Hash:</div>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <code style={{ flex: 1, fontSize: "10px", color: "#888", wordBreak: "break-all" }}>{txHash}</code>
                      <button onClick={() => copyToClipboard(txHash)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#7dd3a8", cursor: "pointer", fontSize: "11px", whiteSpace: "nowrap" }}>Copy</button>
                      <a href={`https://explorer.shelby.xyz/shelbynet/txn/${txHash}`} target="_blank" style={{ color: "#a0c4ff", fontSize: "11px", textDecoration: "none", padding: "4px 8px", border: "1px solid #2a2a4a", borderRadius: "4px", whiteSpace: "nowrap" }}>View TX</a>
                    </div>
                  </div>
                )}

                {shareLink && (
                  <div style={{ background: "#0a1a0a", border: "1px solid #1a3a1a", borderRadius: "6px", padding: "12px" }}>
                    <div style={{ fontSize: "11px", color: "#4ade80", marginBottom: "6px" }}>Share Link (blob stored on Shelby network):</div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <input readOnly value={shareLink} style={{ flex: 1, background: "#111", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 10px", color: "#888", fontFamily: "monospace", fontSize: "10px" }} />
                      <button onClick={() => copyToClipboard(shareLink)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#7dd3a8", cursor: "pointer", fontSize: "11px" }}>Copy</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Show on-chain blobs for this account */}
              {accountBlobs && accountBlobs.length > 0 && (
                <div style={card}>
                  <h2 style={{ margin: "0 0 12px", fontSize: "13px", color: "#888", textTransform: "uppercase" as const, letterSpacing: "1px" }}>Your On-Chain Blobs ({accountBlobs.length})</h2>
                  {accountBlobs.map((blob, i) => (
                    <div key={i} style={{ borderBottom: "1px solid #2a2a2a", padding: "8px 0", fontSize: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <span style={{ color: "#a0c4ff" }}>{blob.blobNameSuffix}</span>
                        <div style={{ color: "#555", fontSize: "11px" }}>
                          {formatSize(blob.size)} · Expires: {new Date(blob.expirationMicros / 1000).toLocaleString()}
                          {blob.isWritten && <span style={{ color: "#4ade80", marginLeft: "6px" }}>● Written</span>}
                        </div>
                      </div>
                      <a href={`https://explorer.shelby.xyz/shelbynet/account/${displayAddress}/blobs?name=${encodeURIComponent(blob.blobNameSuffix)}`}
                        target="_blank" style={{ color: "#7dd3a8", fontSize: "11px", textDecoration: "none", padding: "4px 8px", border: "1px solid #7dd3a8", borderRadius: "4px" }}>Explorer</a>
                    </div>
                  ))}
                </div>
              )}
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
                  <div style={{ display: "flex", gap: "6px" }}>
                    {r.shareLink && (
                      <>
                        <input readOnly value={r.shareLink} style={{ flex: 1, background: "#111", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#555", fontFamily: "monospace", fontSize: "10px" }} />
                        <button onClick={() => copyToClipboard(r.shareLink!)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "3px 6px", color: "#7dd3a8", cursor: "pointer", fontSize: "10px" }}>Copy</button>
                      </>
                    )}
                    {r.status === "ACTIVE" && r.blobName && r.owner && (
                      <button onClick={() => handleDownloadBlob(r)} style={{ background: "transparent", border: "1px solid #7dd3a8", borderRadius: "4px", padding: "3px 8px", color: "#7dd3a8", cursor: "pointer", fontSize: "10px" }}>Download</button>
                    )}
                  </div>
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
                  <span style={{ color: e.type.includes("FAILED") || e.type === "VAULT_WIPED" ? "#f87171" : e.type.includes("COMPLETED") || e.type.includes("DOWNLOADED") ? "#4ade80" : "#7dd3a8", minWidth: "140px" }}>{e.type}</span>
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
