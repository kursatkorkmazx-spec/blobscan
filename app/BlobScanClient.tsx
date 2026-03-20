"use client";
import { useState, useEffect, useRef } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
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
  const { account, connect, wallets, connected, disconnect } = useWallet();
  const walletAddress = account?.address?.toString();
  const [addr, setAddr] = useState("");
  const [searchAddr, setSearchAddr] = useState("");
  const [apt, setApt] = useState("");
  const [usd, setUsd] = useState("");
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [netStatus, setNetStatus] = useState<any>(null);
  const [modalSrc, setModalSrc] = useState("");
  const [modalType, setModalType] = useState<"image" | "video" | "audio">("image");
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [inlinePlayer, setInlinePlayer] = useState<string | null>(null);
  const [inlinePlayerUrl, setInlinePlayerUrl] = useState<string | null>(null);
  const [loadingThumbs, setLoadingThumbs] = useState<Set<string>>(new Set());
  const [accountBlobs, setAccountBlobs] = useState<BlobInfo[]>([]);
  const [blobsLoading, setBlobsLoading] = useState(false);
  const [highlightBlob, setHighlightBlob] = useState<string | null>(null);
  const [decryptKey, setDecryptKey] = useState<string | null>(null); // from URL
  const [decryptPrompt, setDecryptPrompt] = useState<{ blobName: string; resolve: (key: string | null) => void } | null>(null);
  const [decryptInput, setDecryptInput] = useState("");
  const [isOneDownload, setIsOneDownload] = useState(false);
  const [linkConsumed, setLinkConsumed] = useState(false);
  const [keyBlobName, setKeyBlobName] = useState<string | null>(null);
  const [keyExpired, setKeyExpired] = useState(false);
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
    const urlKeyBlob = params.get("keyBlob");
    const urlOneDownload = params.get("oneDownload") === "true";
    if (urlKey) setDecryptKey(urlKey);
    if (urlKeyBlob) setKeyBlobName(urlKeyBlob);
    if (urlBlob) setHighlightBlob(urlBlob);
    if (urlOneDownload) setIsOneDownload(true);

    // Check if this one-download link was already consumed
    if (urlOneDownload && urlBlob && urlAddr) {
      const consumedKey = `consumed_${urlAddr}_${urlBlob}`;
      if (localStorage.getItem(consumedKey)) {
        setLinkConsumed(true);
      }
    }

    if (urlAddr && urlAddr.startsWith("0x")) {
      // Auto-lookup address and show blobs (no auto-download)
      lookupAddress(urlAddr);
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

  async function lookupAddress(address: string) {
    if (!address.startsWith("0x")) { alert("Please enter a valid address starting with 0x"); return; }
    setAddr(address);
    setLoading(true);
    setShown(true);
    setSearchAddr(address);
    setBlobsLoading(true);
    setAccountBlobs([]);
    try {
      const query = `{ current_fungible_asset_balances(where: {owner_address: {_eq: "${address}"}}) { amount asset_type } }`;
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
      const blobs = await fetchAccountBlobs(address);
      setAccountBlobs(blobs);
    } catch (err) {
      console.error("Failed to fetch blobs:", err);
    }
    setBlobsLoading(false);
  }

  function lookup() {
    lookupAddress(addr);
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

      // Try decryption only when share link provides a key or keyBlob
      let key = decryptKey; // from share link URL ?key= param

      // If ONE-DL: fetch key from on-chain key blob
      if (!key && keyBlobName && searchAddr) {
        try {
          const keyBlob = await shelbyClient.download({
            account: searchAddr,
            blobName: keyBlobName,
          });
          const keyReader = keyBlob.readable.getReader();
          const keyChunks: Uint8Array[] = [];
          let keyLen = 0;
          while (true) {
            const { done, value } = await keyReader.read();
            if (done) break;
            keyChunks.push(value);
            keyLen += value.length;
          }
          const keyData = new Uint8Array(keyLen);
          let keyOffset = 0;
          for (const c of keyChunks) { keyData.set(c, keyOffset); keyOffset += c.length; }
          key = new TextDecoder().decode(keyData);
        } catch {
          // Key blob expired or not found — on-chain enforced!
          setKeyExpired(true);
          setLinkConsumed(true);
          alert("🔒 Decryption key has expired on-chain. This file can no longer be decrypted.\n\nThe key blob was automatically destroyed by the Shelby network.");
          setDownloading(null);
          return;
        }
      }

      // Only ask for key manually if this is a share link that requires it
      // (don't prompt for regular explorer downloads — file may not be encrypted)
      if (!key && keyBlobName) {
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

      // Mark as consumed if one-download link
      if (isOneDownload && highlightBlob === blobNameSuffix) {
        const consumedKey = `consumed_${searchAddr}_${blobNameSuffix}`;
        localStorage.setItem(consumedKey, Date.now().toString());
        setLinkConsumed(true);
      }
    } catch (err: any) {
      alert(`Download failed: ${err?.message || "Unknown error"}`);
    } finally {
      setDownloading(null);
    }
  }

  async function loadThumbnail(blobNameSuffix: string) {
    if (!searchAddr || thumbnails[blobNameSuffix] || loadingThumbs.has(blobNameSuffix)) return;
    setLoadingThumbs(prev => new Set(prev).add(blobNameSuffix));
    try {
      const blob = await shelbyClient.download({ account: searchAddr, blobName: blobNameSuffix });
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
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      const ext = blobNameSuffix.split(".").pop()?.toLowerCase() || "";
      const mimeTypes: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", jfif: "image/jpeg" };
      const imageBlob = new Blob([data], { type: mimeTypes[ext] || "image/png" });
      const url = URL.createObjectURL(imageBlob);
      setThumbnails(prev => ({ ...prev, [blobNameSuffix]: url }));
    } catch {}
    setLoadingThumbs(prev => { const s = new Set(prev); s.delete(blobNameSuffix); return s; });
  }

  async function handlePreviewBlob(blobNameSuffix: string) {
    if (!searchAddr || previewLoading) return;
    setPreviewLoading(blobNameSuffix);
    try {
      // Use the same download+decrypt logic that handleDownload uses
      const blob = await shelbyClient.download({ account: searchAddr, blobName: blobNameSuffix });
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

      // Decrypt if share link provides a key
      let key = decryptKey;
      if (!key && keyBlobName && searchAddr) {
        try {
          const keyBlob = await shelbyClient.download({ account: searchAddr, blobName: keyBlobName });
          const keyReader = keyBlob.readable.getReader();
          const keyChunks: Uint8Array[] = [];
          let keyLen = 0;
          while (true) {
            const { done, value } = await keyReader.read();
            if (done) break;
            keyChunks.push(value);
            keyLen += value.length;
          }
          const keyData = new Uint8Array(keyLen);
          let keyOffset = 0;
          for (const c of keyChunks) { keyData.set(c, keyOffset); keyOffset += c.length; }
          key = new TextDecoder().decode(keyData);
        } catch { /* key not available */ }
      }
      if (key) {
        try { data = await decryptData(data, key); } catch { /* not encrypted or wrong key */ }
      }

      console.log(`[preview] downloaded ${data.byteLength} bytes for ${blobNameSuffix}`);
      if (data.byteLength === 0) {
        alert("Preview failed: file is empty (0 bytes).");
        return;
      }

      const ext = blobNameSuffix.split(".").pop()?.toLowerCase() || "";
      const videoExts = ["mp4", "webm", "mov"];
      const audioExts = ["mp3", "wav", "aac", "m4a", "flac", "ogg"];
      const mimeTypes: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
        gif: "image/gif", webp: "image/webp", jfif: "image/jpeg",
        mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
        mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac",
        m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg",
      };
      const isVideo = videoExts.includes(ext);
      const isAudio = audioExts.includes(ext);
      const mime = mimeTypes[ext] || "image/png";
      const mediaBlob = new Blob([data], { type: mime });
      const url = URL.createObjectURL(mediaBlob);
      setModalType(isVideo ? "video" : isAudio ? "audio" : "image");
      setModalSrc(url);
    } catch (err: any) {
      alert(`Preview failed: ${err?.message || "Unknown error"}`);
    } finally {
      setPreviewLoading(null);
    }
  }

  const card = { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "20px", marginBottom: "16px" } as const;

  return (
    <div className="blobscan-root" style={{ fontFamily: "monospace", background: "#0f0f0f", color: "#e0e0e0", minHeight: "100vh", paddingBottom: "120px", maxWidth: "800px", margin: "0 auto", position: "relative" }}>
      <canvas ref={canvasRef} style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", zIndex: -1, opacity: 0.08, pointerEvents: "none" }} />
      {modalSrc && (
        <div onClick={() => { URL.revokeObjectURL(modalSrc); setModalSrc(""); }} style={{ display: "flex", position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.9)", zIndex: 999, cursor: "zoom-out", alignItems: "center", justifyContent: "center" }}>
          {modalType === "video" ? (
            <video
              src={modalSrc}
              controls
              playsInline
              style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: "8px" }}
              onClick={e => e.stopPropagation()}
              onError={e => {
                const v = e.currentTarget as HTMLVideoElement;
                const code = v.error?.code;
                const msgs: Record<number, string> = {
                  1: "Load aborted",
                  2: "Network error",
                  3: "Decode error (unsupported codec — try H.264)",
                  4: "Format not supported by this browser",
                };
                const detail = v.error?.message || "";
                alert(`Video playback failed (error ${code ?? "?"}): ${msgs[code ?? 0] ?? "Unknown error"}\n\nBrowser: ${detail}\n\nCheck browser console for blob URL and size info.`);
              }}
            />
          ) : modalType === "audio" ? (
            <audio
              src={modalSrc}
              controls
              autoPlay
              style={{ width: "320px", borderRadius: "8px" }}
              onClick={e => e.stopPropagation()}
              onError={e => {
                const a = e.currentTarget as HTMLAudioElement;
                const code = a.error?.code;
                const msgs: Record<number, string> = {
                  1: "Load aborted",
                  2: "Network error",
                  3: "Decode error (unsupported codec)",
                  4: "Format not supported by this browser",
                };
                alert(`Audio playback failed (error ${code ?? "?"}): ${msgs[code ?? 0] ?? "Unknown error"}`);
              }}
            />
          ) : (
            <img src={modalSrc} style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: "8px" }} />
          )}
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

      {/* Consumed / key expired banner */}
      {keyExpired && (
        <div style={{ background: "#3a1010", border: "1px solid #f87171", borderRadius: "8px", padding: "16px", marginBottom: "16px", textAlign: "center" as const }}>
          <div style={{ fontSize: "14px", color: "#f87171", fontWeight: "bold", marginBottom: "4px" }}>🔒 Decryption Key Destroyed</div>
          <div style={{ fontSize: "12px", color: "#888" }}>The key blob has expired on-chain. This file can no longer be decrypted. The Shelby network automatically destroyed the decryption key.</div>
        </div>
      )}
      {linkConsumed && isOneDownload && !keyExpired && (
        <div style={{ background: "#3a1010", border: "1px solid #f87171", borderRadius: "8px", padding: "16px", marginBottom: "16px", textAlign: "center" as const }}>
          <div style={{ fontSize: "14px", color: "#f87171", fontWeight: "bold", marginBottom: "4px" }}>⚡ This link has been consumed</div>
          <div style={{ fontSize: "12px", color: "#888" }}>This was a one-time download link and has already been used.</div>
        </div>
      )}

      {/* Wallet panel - top right */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <div />
        {connected ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ background: "#1a1a1a", border: "1px solid #1a3a2a", borderRadius: "6px", padding: "6px 12px", fontSize: "11px" }}>
              <span style={{ color: "#4ade80" }}>● Connected</span>
              <span style={{ color: "#555", marginLeft: "6px" }}>{walletAddress?.slice(0, 8)}...{walletAddress?.slice(-6)}</span>
            </div>
            <button onClick={() => disconnect()}
              style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "4px 8px", color: "#555", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>Disconnect</button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: "6px" }}>
            {wallets.filter(w => w.name === "Petra").map((w) => (
              <button key={w.name} onClick={() => connect(w.name)}
                style={{ background: "#1a1a1a", border: "1px solid #7dd3a8", borderRadius: "6px", padding: "6px 14px", color: "#7dd3a8", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>Connect Petra</button>
            ))}
            {wallets.filter(w => w.name === "Petra").length === 0 && (
              <a href="https://petra.app" target="_blank" style={{ color: "#555", fontSize: "11px", textDecoration: "none", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "6px 14px" }}>Install Petra</a>
            )}
          </div>
        )}
      </div>

      <h1 style={{ color: "#7dd3a8", marginBottom: "4px" }}>BlobScan</h1>
      <div style={{ color: "#666", fontSize: "13px", marginBottom: "32px" }}>
        <div style={{ color: "#666", fontSize: "13px", marginBottom: "32px" }}>shelbynet · Real blob explorer</div>
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <input value={addr} onChange={e => setAddr(e.target.value)} onKeyDown={e => e.key === "Enter" && lookup()} placeholder="Enter wallet address (0x...)"
          style={{ flex: 1, background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "10px 14px", color: "#e0e0e0", fontFamily: "monospace", fontSize: "13px", outline: "none" }} />
        {connected && walletAddress && (
          <button onClick={() => lookupAddress(walletAddress)}
            style={{ background: "#1a1a1a", border: "1px solid #7dd3a8", borderRadius: "6px", padding: "10px 14px", fontFamily: "monospace", fontSize: "13px", cursor: "pointer", color: "#7dd3a8", whiteSpace: "nowrap" }}>My</button>
        )}
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
              const isVideo = blob.blobNameSuffix.match(/\.(mp4|webm|mov)$/i);
              const isAudio = blob.blobNameSuffix.match(/\.(mp3|wav|aac|m4a|flac|ogg)$/i);
              const isExpired = blob.expirationMicros < Date.now() * 1000;
              const explorerUrl = `https://explorer.shelby.xyz/shelbynet/account/${searchAddr}/blobs?name=${encodeURIComponent(blob.blobNameSuffix)}`;
              const isHighlighted = highlightBlob === blob.blobNameSuffix;
              if (isImage && !isExpired && !thumbnails[blob.blobNameSuffix]) {
                loadThumbnail(blob.blobNameSuffix);
              }
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", borderBottom: "1px solid #2a2a2a", padding: "10px 0", ...(isHighlighted ? { background: "#0a1a0a", border: "1px solid #7dd3a8", borderRadius: "6px", padding: "10px", marginBottom: "4px" } : {}) }}>
                  {isImage ? (
                    <div onClick={() => handlePreviewBlob(blob.blobNameSuffix)}
                      style={{ width: "40px", height: "40px", background: "#111", borderRadius: "4px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", cursor: previewLoading === blob.blobNameSuffix ? "default" : "zoom-in", color: "#7dd3a8", overflow: "hidden", flexShrink: 0 }}>
                      {previewLoading === blob.blobNameSuffix
                        ? <span style={{ fontSize: "10px", color: "#555" }}>...</span>
                        : thumbnails[blob.blobNameSuffix]
                          ? <img src={thumbnails[blob.blobNameSuffix]} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          : loadingThumbs.has(blob.blobNameSuffix) ? <span style={{ fontSize: "10px", color: "#555" }}>...</span> : "🖼"}
                    </div>
                  ) : isVideo || isAudio ? (
                    <div onClick={() => handlePreviewBlob(blob.blobNameSuffix)}
                      style={{ width: "40px", height: "40px", background: "#111", borderRadius: "4px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: previewLoading === blob.blobNameSuffix ? "10px" : "18px", cursor: previewLoading ? "default" : "pointer", color: "#7dd3a8" }}>
                      {previewLoading === blob.blobNameSuffix ? "..." : isAudio ? "🎵" : "▶️"}
                    </div>
                  ) : (
                    <div style={{ width: "40px", height: "40px", background: "#111", borderRadius: "4px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px" }}>📄</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
                      <span style={{ color: "#a0c4ff", fontSize: "13px", wordBreak: "break-all" }}>{blob.blobNameSuffix}</span>
                      {isHighlighted && !linkConsumed && <span style={{ fontSize: "10px", color: "#7dd3a8", background: "#1a3a2a", padding: "1px 6px", borderRadius: "3px" }}>Shared with you</span>}
                      {isHighlighted && isOneDownload && <span style={{ fontSize: "10px", color: "#f87171", background: "#3a1010", padding: "1px 6px", borderRadius: "3px" }}>⚡ ONE-DL</span>}
                      {isHighlighted && linkConsumed && <span style={{ fontSize: "10px", color: "#f87171", background: "#3a1010", padding: "1px 6px", borderRadius: "3px" }}>CONSUMED</span>}
                    </div>
                    <div style={{ color: "#555", fontSize: "11px", marginTop: "2px" }}>
                      {formatSize(blob.size)}
                      {" · "}
                      {isExpired
                        ? <span style={{ color: "#f87171" }}>Expired</span>
                        : <>Expires: {new Date(blob.expirationMicros / 1000).toLocaleString()}</>
                      }
                      {blob.isWritten && <span style={{ color: "#4ade80", marginLeft: "6px" }}>● Written</span>}
                      {blob.isDeleted && <span style={{ color: "#f87171", marginLeft: "6px" }}>● Deleted</span>}
                    </div>
                    <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
                      <a href={explorerUrl} target="_blank" style={{ color: "#555", fontSize: "11px", textDecoration: "none", padding: "4px 8px", border: "1px solid #2a2a2a", borderRadius: "4px" }}>Explorer</a>
                      {!isExpired && blob.isWritten && !(isHighlighted && linkConsumed) && (
                        <button onClick={() => handleDownload(blob.blobNameSuffix)}
                          disabled={downloading === blob.blobNameSuffix}
                          style={{ color: "#7dd3a8", fontSize: "11px", background: "transparent", padding: "4px 8px", border: "1px solid #7dd3a8", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", opacity: downloading === blob.blobNameSuffix ? 0.5 : 1 }}>
                          {downloading === blob.blobNameSuffix ? "Downloading..." : "Download"}
                        </button>
                      )}
                      {!isExpired && blob.isWritten && (isVideo || isAudio) && !(isHighlighted && linkConsumed) && (
                        <button onClick={async () => {
                          if (inlinePlayer === blob.blobNameSuffix) {
                            if (inlinePlayerUrl) URL.revokeObjectURL(inlinePlayerUrl);
                            setInlinePlayer(null);
                            setInlinePlayerUrl(null);
                            return;
                          }
                          setInlinePlayer(blob.blobNameSuffix);
                          setInlinePlayerUrl(null);
                          try {
                            const dl = await shelbyClient.download({ account: searchAddr!, blobName: blob.blobNameSuffix });
                            const r = dl.readable.getReader();
                            const ch: Uint8Array[] = [];
                            let len = 0;
                            while (true) { const { done, value } = await r.read(); if (done) break; ch.push(value); len += value.length; }
                            let d = new Uint8Array(len);
                            let o = 0;
                            for (const c of ch) { d.set(c, o); o += c.length; }
                            // decrypt if needed
                            let k = decryptKey;
                            if (!k && keyBlobName && searchAddr) {
                              try {
                                const kb = await shelbyClient.download({ account: searchAddr, blobName: keyBlobName });
                                const kr = kb.readable.getReader();
                                const kc: Uint8Array[] = [];
                                let kl = 0;
                                while (true) { const { done, value } = await kr.read(); if (done) break; kc.push(value); kl += value.length; }
                                const kd = new Uint8Array(kl);
                                let ko = 0;
                                for (const c of kc) { kd.set(c, ko); ko += c.length; }
                                k = new TextDecoder().decode(kd);
                              } catch {}
                            }
                            if (k) { try { d = await decryptData(d, k); } catch {} }
                            if (d.byteLength === 0) { alert("File is empty (0 bytes)."); setInlinePlayer(null); return; }
                            const ext = blob.blobNameSuffix.split(".").pop()?.toLowerCase() || "";
                            const mimes: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg" };
                            const url = URL.createObjectURL(new Blob([d], { type: mimes[ext] || "application/octet-stream" }));
                            setInlinePlayerUrl(url);
                          } catch (e: any) {
                            alert(`Play failed: ${e?.message || "Unknown error"}`);
                            setInlinePlayer(null);
                          }
                        }}
                          style={{ color: inlinePlayer === blob.blobNameSuffix ? "#f87171" : "#a78bfa", fontSize: "11px", background: "transparent", padding: "4px 8px", border: `1px solid ${inlinePlayer === blob.blobNameSuffix ? "#f87171" : "#a78bfa"}`, borderRadius: "4px", cursor: "pointer", fontFamily: "monospace" }}>
                          {inlinePlayer === blob.blobNameSuffix && !inlinePlayerUrl ? "Loading..." : inlinePlayer === blob.blobNameSuffix ? "Stop" : isAudio ? "Play" : "Play"}
                        </button>
                      )}
                      {isHighlighted && linkConsumed && (
                        <span style={{ color: "#f87171", fontSize: "11px", padding: "4px 8px", border: "1px solid #3a1010", borderRadius: "4px" }}>Link used</span>
                      )}
                    </div>
                    {inlinePlayer === blob.blobNameSuffix && inlinePlayerUrl && (
                      <div style={{ marginTop: "8px" }}>
                        {isVideo ? (
                          <video src={inlinePlayerUrl} controls autoPlay playsInline style={{ width: "100%", maxHeight: "300px", borderRadius: "6px", background: "#000" }} />
                        ) : (
                          <audio src={inlinePlayerUrl} controls autoPlay style={{ width: "100%", borderRadius: "6px" }} />
                        )}
                      </div>
                    )}
                  </div>
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
        Built by <a href="https://twitter.com/solscammer" target="_blank" style={{ color: "#555", textDecoration: "none" }}>@solscammer</a>
      </div>
      <style>{`
        @keyframes blink { 50% { opacity: 0; } }
        .blobscan-root { padding: 32px; }
        @media (max-width: 600px) {
          .blobscan-root { padding: 14px; }
        }
      `}</style>
    </div>
  );
}
