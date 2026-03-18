"use client";
import { useState, useEffect, useRef } from "react";
import { shelbyClient } from "./shelbyClient";

const SHELBY_DEPLOYER = "0x85fdb9a176ab8ef1d9d9c1b60d60b3924f0800ac1de1cc2085fb0b8bb4988e6a";
const BLOB_REGISTER_EVENT = `${SHELBY_DEPLOYER}::blob_metadata::BlobRegisteredEvent`;
const BLOB_DELETE_EVENT = `${SHELBY_DEPLOYER}::blob_metadata::BlobDeletedEvent`;

interface BlobInfo {
  blobName: string;
  blobNameSuffix: string;
  size: number;
  expirationMicros: number;
  creationMicros: number;
  isWritten: boolean;
  isDeleted: boolean;
  txHash: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// Fetch blobs from on-chain transactions (no API key needed)
async function fetchAccountBlobs(address: string): Promise<BlobInfo[]> {
  try {
    const res = await fetch(`https://api.shelbynet.shelby.xyz/v1/accounts/${address}/transactions?limit=100`);
    if (!res.ok) return [];
    const txns = await res.json();

    const blobs: BlobInfo[] = [];
    const deletedNames = new Set<string>();

    // First pass: collect deleted blob names
    for (const tx of txns) {
      if (!tx.success) continue;
      for (const ev of tx.events || []) {
        if (ev.type === BLOB_DELETE_EVENT) {
          deletedNames.add(ev.data?.blob_name || "");
        }
      }
    }

    // Second pass: collect registered blobs
    for (const tx of txns) {
      if (!tx.success) continue;
      for (const ev of tx.events || []) {
        if (ev.type === BLOB_REGISTER_EVENT) {
          const d = ev.data;
          const fullName = d.blob_name || "";
          const suffix = fullName.includes("/") ? fullName.split("/").slice(1).join("/") : fullName;
          const isDeleted = deletedNames.has(fullName);

          // Check if already in list (avoid duplicates)
          if (!blobs.some(b => b.blobName === fullName)) {
            blobs.push({
              blobName: fullName,
              blobNameSuffix: suffix,
              size: parseInt(d.blob_size || "0"),
              expirationMicros: parseInt(d.expiration_micros || "0"),
              creationMicros: parseInt(d.creation_micros || "0"),
              isWritten: true,
              isDeleted,
              txHash: tx.hash,
            });
          }
        }
      }
    }

    return blobs.sort((a, b) => b.creationMicros - a.creationMicros);
  } catch (err) {
    console.error("Failed to fetch blobs:", err);
    return [];
  }
}

export default function BlobScanClient() {
  const [addr, setAddr] = useState("");
  const [searchAddr, setSearchAddr] = useState("");
  const [apt, setApt] = useState("");
  const [usd, setUsd] = useState("");
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [netStatus, setNetStatus] = useState<any>(null);
  const [modalSrc, setModalSrc] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [accountBlobs, setAccountBlobs] = useState<BlobInfo[]>([]);
  const [blobsLoading, setBlobsLoading] = useState(false);
  const [highlightBlob, setHighlightBlob] = useState<string | null>(null);
  const [decryptKey, setDecryptKey] = useState<string | null>(null); // from URL
  const [decryptPrompt, setDecryptPrompt] = useState<{ blobName: string; resolve: (key: string | null) => void } | null>(null);
  const [decryptInput, setDecryptInput] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const twRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const cols = Math.floor(canvas.width / 20);
    const drops = Array(cols).fill(1);
    const chars = "アイウエオカキクケコ0123456789ABCDEF";
    const interval = setInterval(() => {
      ctx.fillStyle = "rgba(0,0,0,0.05)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#7dd3a8";
      ctx.font = "14px monospace";
      drops.forEach((y, i) => {
        const char = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(char, i * 20, y * 20);
        if (y * 20 > canvas.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      });
    }, 50);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const msgs = [
      "> Enter a wallet address to check balance and blobs",
      "> Blobs are stored on the Shelby decentralized network",
      "> Download blobs directly from storage providers",
      "> Blob uploads require APT for gas fees",
    ];
    let li = 0, ci = 0, deleting = false;
    const el = twRef.current;
    if (!el) return;
    let timeout: any;
    function type() {
      const line = msgs[li];
      if (!deleting) {
        el!.textContent = line.slice(0, ++ci);
        if (ci === line.length) { deleting = true; timeout = setTimeout(type, 2000); return; }
        timeout = setTimeout(type, 40);
      } else {
        el!.textContent = line.slice(0, --ci);
        if (ci === 0) { deleting = false; li = (li + 1) % msgs.length; timeout = setTimeout(type, 400); return; }
        timeout = setTimeout(type, 20);
      }
    }
    type();
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    loadNetwork();
    const interval = setInterval(loadNetwork, 30000);
    return () => clearInterval(interval);
  }, []);

  // Handle share link URL params: ?address=0x...&blob=filename&key=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlAddr = params.get("address");
    const urlBlob = params.get("blob");
    const urlKey = params.get("key");
    if (urlKey) setDecryptKey(urlKey);
    if (urlBlob) setHighlightBlob(urlBlob);
    if (urlAddr && urlAddr.startsWith("0x")) {
      setAddr(urlAddr);
      // Auto-lookup address and show blobs (no auto-download)
      (async () => {
        setLoading(true);
        setShown(true);
        setSearchAddr(urlAddr);
        setBlobsLoading(true);
        try {
          const query = `{ current_fungible_asset_balances(where: {owner_address: {_eq: "${urlAddr}"}}) { amount asset_type } }`;
          const r = await fetch("https://api.shelbynet.shelby.xyz/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
          const data = await r.json();
          const balances = data.data?.current_fungible_asset_balances || [];
          const aptB = balances.find((b: any) => b.asset_type === "0x1::aptos_coin::AptosCoin");
          const usdB = balances.find((b: any) => b.asset_type.includes("1b18363"));
          setApt(aptB ? (aptB.amount / 100000000).toFixed(2) + " APT" : "0 APT");
          setUsd(usdB ? (usdB.amount / 100000000).toFixed(2) + " ShelbyUSD" : "0 ShelbyUSD");
        } catch {}
        setLoading(false);

        const blobs = await fetchAccountBlobs(urlAddr);
        setAccountBlobs(blobs);
        setBlobsLoading(false);
      })();
    }
  }, []);

  async function loadNetwork() {
    try {
      const r = await fetch("https://api.shelbynet.shelby.xyz/v1/");
      const d = await r.json();
      await new Promise(res => setTimeout(res, 1000));
      const r2 = await fetch("https://api.shelbynet.shelby.xyz/v1/");
      const d2 = await r2.json();
      const tps = (parseInt(d2.ledger_version) - parseInt(d.ledger_version)).toFixed(1);
      setNetStatus({ ...d2, tps });
    } catch {}
  }

  async function lookup() {
    if (!addr.startsWith("0x")) { alert("Please enter a valid address starting with 0x"); return; }
    setLoading(true);
    setShown(true);
    setSearchAddr(addr);
    setBlobsLoading(true);
    setAccountBlobs([]);
    try {
      const query = `{ current_fungible_asset_balances(where: {owner_address: {_eq: "${addr}"}}) { amount asset_type } }`;
      const r = await fetch("https://api.shelbynet.shelby.xyz/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      const data = await r.json();
      const balances = data.data?.current_fungible_asset_balances || [];
      const aptB = balances.find((b: any) => b.asset_type === "0x1::aptos_coin::AptosCoin");
      const usdB = balances.find((b: any) => b.asset_type.includes("1b18363"));
      setApt(aptB ? (aptB.amount / 100000000).toFixed(2) + " APT" : "0 APT");
      setUsd(usdB ? (usdB.amount / 100000000).toFixed(2) + " ShelbyUSD" : "0 ShelbyUSD");
    } catch {}
    setLoading(false);

    // Fetch blobs from on-chain transactions
    try {
      const blobs = await fetchAccountBlobs(addr);
      setAccountBlobs(blobs);
    } catch (err) {
      console.error("Failed to fetch blobs:", err);
    }
    setBlobsLoading(false);
  }

  async function decryptData(data: Uint8Array<ArrayBuffer>, key: string): Promise<Uint8Array<ArrayBuffer>> {
    const salt = data.slice(0, 16);
    const iv = data.slice(16, 28);
    const ciphertext = data.slice(28);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(key), "PBKDF2", false, ["deriveKey"]);
    const cryptoKey = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
    return new Uint8Array(decrypted);
  }

  function askForDecryptKey(blobName: string): Promise<string | null> {
    return new Promise((resolve) => {
      setDecryptInput("");
      setDecryptPrompt({ blobName, resolve });
    });
  }

  async function handleDownload(blobNameSuffix: string) {
    if (!searchAddr) return;
    try {
      setDownloading(blobNameSuffix);
      const blob = await shelbyClient.download({
        account: searchAddr,
        blobName: blobNameSuffix,
      });

      // Read the stream
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

      // Try decryption: use URL key, or ask user
      let key = decryptKey; // from share link URL
      if (!key) {
        // Check if data looks encrypted (try to detect AES-GCM format)
        // Ask user if they want to provide a decryption key
        key = await askForDecryptKey(blobNameSuffix);
      }

      if (key) {
        try {
          data = await decryptData(data, key);
        } catch {
          alert("Decryption failed — wrong key. Downloading encrypted file.");
        }
      }

      // Trigger browser download
      const downloadBlob = new Blob([data]);
      const url = URL.createObjectURL(downloadBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = blobNameSuffix.split("/").pop() || blobNameSuffix;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Download failed: ${err?.message || "Unknown error"}`);
    } finally {
      setDownloading(null);
    }
  }

  async function handlePreviewBlob(blobNameSuffix: string) {
    if (!searchAddr) return;
    try {
      const blob = await shelbyClient.download({
        account: searchAddr,
        blobName: blobNameSuffix,
      });

      const reader = blob.readable.getReader();
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.length;
      }
      const data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }

      const ext = blobNameSuffix.split(".").pop()?.toLowerCase() || "";
      const mimeTypes: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
        gif: "image/gif", webp: "image/webp", jfif: "image/jpeg",
      };
      const mime = mimeTypes[ext] || "image/png";
      const imageBlob = new Blob([data], { type: mime });
      const url = URL.createObjectURL(imageBlob);
      setModalSrc(url);
    } catch (err: any) {
      alert(`Preview failed: ${err?.message || "Unknown error"}`);
    }
  }

  const card = { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "20px", marginBottom: "16px" } as const;

  return (
    <div style={{ fontFamily: "monospace", background: "#0f0f0f", color: "#e0e0e0", minHeight: "100vh", padding: "32px", paddingBottom: "120px", maxWidth: "800px", margin: "0 auto", position: "relative" }}>
      <canvas ref={canvasRef} style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", zIndex: -1, opacity: 0.08, pointerEvents: "none" }} />
      {modalSrc && (
        <div onClick={() => { URL.revokeObjectURL(modalSrc); setModalSrc(""); }} style={{ display: "flex", position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.9)", zIndex: 999, cursor: "zoom-out", alignItems: "center", justifyContent: "center" }}>
          <img src={modalSrc} style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: "8px" }} />
        </div>
      )}
      {/* Decrypt key prompt modal */}
      {decryptPrompt && (
        <div style={{ display: "flex", position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.85)", zIndex: 1000, alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "24px", maxWidth: "420px", width: "90%" }}>
            <div style={{ fontSize: "13px", color: "#7dd3a8", marginBottom: "4px" }}>🔒 Encrypted Blob</div>
            <div style={{ fontSize: "12px", color: "#888", marginBottom: "12px" }}>
              <span style={{ color: "#a0c4ff" }}>{decryptPrompt.blobName}</span> may be encrypted. Enter the decryption key or skip to download raw data.
            </div>
            <input value={decryptInput} onChange={e => setDecryptInput(e.target.value)} placeholder="Enter decryption key..."
              onKeyDown={e => { if (e.key === "Enter" && decryptInput) { decryptPrompt.resolve(decryptInput); setDecryptPrompt(null); } }}
              style={{ width: "100%", background: "#111", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "8px 12px", color: "#e0e0e0", fontFamily: "monospace", fontSize: "12px", marginBottom: "12px", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => { decryptPrompt.resolve(null); setDecryptPrompt(null); }}
                style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 14px", color: "#888", fontFamily: "monospace", fontSize: "12px", cursor: "pointer" }}>Skip (raw)</button>
              <button onClick={() => { decryptPrompt.resolve(decryptInput || null); setDecryptPrompt(null); }}
                disabled={!decryptInput}
                style={{ background: decryptInput ? "#7dd3a8" : "#333", color: "#0f0f0f", border: "none", borderRadius: "4px", padding: "6px 14px", fontFamily: "monospace", fontSize: "12px", cursor: decryptInput ? "pointer" : "default", fontWeight: "bold" }}>Decrypt & Download</button>
            </div>
          </div>
        </div>
      )}

      <h1 style={{ color: "#7dd3a8", marginBottom: "4px" }}>BlobScan</h1>
      <div style={{ color: "#666", fontSize: "13px", marginBottom: "32px" }}>
        <div style={{ color: "#666", fontSize: "13px", marginBottom: "32px" }}>shelbynet · Real blob explorer</div>
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <input value={addr} onChange={e => setAddr(e.target.value)} onKeyDown={e => e.key === "Enter" && lookup()} placeholder="Enter wallet address (0x...)"
          style={{ flex: 1, background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "10px 14px", color: "#e0e0e0", fontFamily: "monospace", fontSize: "13px", outline: "none" }} />
        <button onClick={lookup} style={{ background: "#7dd3a8", color: "#0f0f0f", border: "none", borderRadius: "6px", padding: "10px 20px", fontFamily: "monospace", fontSize: "13px", cursor: "pointer", fontWeight: "bold" }}>Look up</button>
      </div>

      <div style={{ fontSize: "12px", color: "#444", marginBottom: "24px", minHeight: "18px" }}>
        <span ref={twRef} style={{ color: "#7dd3a8" }}></span>
        <span style={{ display: "inline-block", width: "7px", height: "13px", background: "#7dd3a8", marginLeft: "2px", verticalAlign: "middle", animation: "blink 0.8s step-end infinite" }}></span>
      </div>

      <div style={card}>
        <p style={{ fontSize: "13px", color: "#888", margin: "0 0 4px" }}>Want to upload files to the Shelby network?</p>
        <p style={{ fontSize: "12px", color: "#555", margin: "0 0 12px" }}>Connect your Petra wallet and upload files directly to decentralized hot storage. Files are distributed across the Shelby node network for sub-second retrieval.</p>
        <a href="/upload" style={{ display: "inline-block", color: "#7dd3a8", border: "1px solid #7dd3a8", borderRadius: "6px", padding: "8px 18px", fontFamily: "monospace", fontSize: "12px", textDecoration: "none" }}>Upload Files →</a>
      </div>

      {shown && (
        <>
          <div style={card}>
            <h2 style={{ margin: "0 0 12px", fontSize: "13px", color: "#888", textTransform: "uppercase", letterSpacing: "1px" }}>Balance</h2>
            <div style={{ display: "flex", gap: "32px" }}>
              <div><div style={{ fontSize: "12px", color: "#666" }}>APT</div><div style={{ fontSize: "24px", color: "#7dd3a8", fontWeight: "bold" }}>{loading ? "..." : apt}</div></div>
              <div><div style={{ fontSize: "12px", color: "#666" }}>ShelbyUSD</div><div style={{ fontSize: "24px", color: "#7dd3a8", fontWeight: "bold" }}>{loading ? "..." : usd}</div></div>
            </div>
            <div style={{ fontSize: "11px", color: "#444", wordBreak: "break-all", marginTop: "8px" }}>{searchAddr}</div>
          </div>

          <div style={card}>
            <h2 style={{ margin: "0 0 12px", fontSize: "13px", color: "#888", textTransform: "uppercase", letterSpacing: "1px" }}>
              Blob List {accountBlobs ? `(${accountBlobs.length})` : ""}
            </h2>
            {blobsLoading ? (
              <div style={{ fontSize: "13px", color: "#7dd3a8" }}>Loading blobs from Shelby network...</div>
            ) : !accountBlobs || accountBlobs.length === 0 ? (
              <div style={{ fontSize: "13px", color: "#444" }}>No blobs found for this address.</div>
            ) : accountBlobs.map((blob, i) => {
              const isImage = blob.blobNameSuffix.match(/\.(jpg|jpeg|png|gif|webp|jfif)$/i);
              const isExpired = blob.expirationMicros < Date.now() * 1000;
              const explorerUrl = `https://explorer.shelby.xyz/shelbynet/account/${searchAddr}/blobs?name=${encodeURIComponent(blob.blobNameSuffix)}`;
              const isHighlighted = highlightBlob === blob.blobNameSuffix;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", borderBottom: "1px solid #2a2a2a", padding: "10px 0", ...(isHighlighted ? { background: "#0a1a0a", border: "1px solid #7dd3a8", borderRadius: "6px", padding: "10px", marginBottom: "4px" } : {}) }}>
                  {isImage ? (
                    <div onClick={() => handlePreviewBlob(blob.blobNameSuffix)}
                      style={{ width: "40px", height: "40px", background: "#111", borderRadius: "4px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", cursor: "zoom-in", color: "#7dd3a8" }}>🖼</div>
                  ) : (
                    <div style={{ width: "40px", height: "40px", background: "#111", borderRadius: "4px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px" }}>📄</div>
                  )}
                  <div style={{ flex: 1 }}>
                    <span style={{ color: "#a0c4ff", fontSize: "13px" }}>{blob.blobNameSuffix}</span>
                    {isHighlighted && <span style={{ fontSize: "10px", color: "#7dd3a8", marginLeft: "6px", background: "#1a3a2a", padding: "1px 6px", borderRadius: "3px" }}>Shared with you</span>}
                    <div style={{ color: "#555", fontSize: "11px" }}>
                      {formatSize(blob.size)}
                      {" · "}
                      {isExpired
                        ? <span style={{ color: "#f87171" }}>Expired</span>
                        : <>Expires: {new Date(blob.expirationMicros / 1000).toLocaleString()}</>
                      }
                      {blob.isWritten && <span style={{ color: "#4ade80", marginLeft: "6px" }}>● Written</span>}
                      {blob.isDeleted && <span style={{ color: "#f87171", marginLeft: "6px" }}>● Deleted</span>}
                    </div>
                  </div>
                  <a href={explorerUrl} target="_blank" style={{ color: "#555", fontSize: "11px", textDecoration: "none", padding: "4px 8px", border: "1px solid #2a2a2a", borderRadius: "4px", marginRight: "4px" }}>Explorer</a>
                  {!isExpired && blob.isWritten && (
                    <button onClick={() => handleDownload(blob.blobNameSuffix)}
                      disabled={downloading === blob.blobNameSuffix}
                      style={{ color: "#7dd3a8", fontSize: "11px", background: "transparent", padding: "4px 8px", border: "1px solid #7dd3a8", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", opacity: downloading === blob.blobNameSuffix ? 0.5 : 1 }}>
                      {downloading === blob.blobNameSuffix ? "Downloading..." : "Download"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: "800px", margin: "0 auto", background: "#1a1a1a", borderTop: "1px solid #2a2a2a", padding: "12px 20px", zIndex: 100 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: "13px", color: "#888", textTransform: "uppercase", letterSpacing: "1px" }}>Network Status</h2>
        {netStatus ? (
          <div style={{ fontSize: "12px" }}>
            <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: "4px", fontSize: "12px", marginRight: "6px", background: "#1a3a2a", color: "#4ade80" }}>Online</span>
            <span style={{ color: "#555" }}>Block: <span style={{ color: "#a0c4ff" }}>{parseInt(netStatus.block_height).toLocaleString()}</span></span>
            {" · "}
            <span style={{ color: "#555" }}>TPS: <span style={{ color: "#4ade80" }}>{netStatus.tps}</span></span>
            {netStatus.totalBlobs && <>{" · "}<span style={{ color: "#555" }}>Total Blobs: <span style={{ color: "#a0c4ff" }}>{netStatus.totalBlobs}</span></span></>}
            {netStatus.totalStorage && <>{" · "}<span style={{ color: "#555" }}>Storage: <span style={{ color: "#a0c4ff" }}>{netStatus.totalStorage}</span></span></>}
            {" · "}
            <a href="https://explorer.shelby.xyz/shelbynet" target="_blank" style={{ color: "#7dd3a8", fontSize: "12px" }}>explorer.shelby.xyz</a>
          </div>
        ) : <div style={{ fontSize: "12px", color: "#555" }}>Loading...</div>}
      </div>

      <div style={{ textAlign: "center" as const, fontSize: "11px", color: "#333", padding: "40px 0 16px" }}>
        Built by <a href="https://twitter.com/solscammer" target="_blank" style={{ color: "#555", textDecoration: "none" }}>@solscammer</a> · Powered by <a href="https://shelby.xyz" target="_blank" style={{ color: "#555", textDecoration: "none" }}>Shelby Protocol</a>
      </div>
      <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>
    </div>
  );
}
