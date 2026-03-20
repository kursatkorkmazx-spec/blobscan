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


  // ─── Styles ──────────────────────────────────────────────────────────────────
  const S = {
    sidebar: { width: "190px", minHeight: "100vh", background: "#111", borderRight: "1px solid #1f1f1f", display: "flex", flexDirection: "column", flexShrink: 0, position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50 } as const,
    main: { marginLeft: "190px", minHeight: "100vh", display: "flex", flexDirection: "column", flex: 1, width: "calc(100% - 190px)" } as const,
    topbar: { background: "#0d0d0d", borderBottom: "1px solid #1f1f1f", padding: "0 24px", height: "52px", display: "flex", alignItems: "center", gap: "12px", position: "sticky", top: 0, zIndex: 40 } as const,
    content: { padding: "28px 28px 80px", flex: 1 } as const,
    input: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "8px 14px", color: "#e5e5e5", fontSize: "13px", outline: "none", fontFamily: "inherit" } as const,
    btnGreen: { background: "#39FF14", color: "#0a0a0a", border: "none", borderRadius: "8px", padding: "8px 18px", fontSize: "13px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" } as const,
    btnOutline: { background: "transparent", border: "1px solid #333", borderRadius: "8px", padding: "6px 14px", color: "#aaa", fontSize: "13px", cursor: "pointer", fontFamily: "inherit" } as const,
    btnGreenOutline: { background: "rgba(57,255,20,0.1)", border: "1px solid rgba(57,255,20,0.3)", borderRadius: "8px", padding: "6px 14px", color: "#39FF14", fontSize: "13px", cursor: "pointer", fontFamily: "inherit" } as const,
    navItem: (active: boolean) => ({ display: "flex", alignItems: "center", gap: "10px", padding: "9px 16px", borderRadius: "8px", margin: "2px 10px", cursor: "pointer", fontSize: "14px", color: active ? "#39FF14" : "#aaa", background: active ? "rgba(57,255,20,0.1)" : "transparent", fontWeight: active ? 600 : 400 } as const),
    card: { background: "#161616", border: "1px solid #222", borderRadius: "12px", padding: "20px", marginBottom: "12px" } as const,
  };

  const NavIcon = ({ d }: { d: string }) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );

  return (
    <div style={{ display: "flex", background: "#0d0d0d", minHeight: "100vh" }}>

      {/* ── Sidebar ── */}
      <aside style={S.sidebar}>
        {/* Logo */}
        <div style={{ padding: "16px 14px 14px", borderBottom: "1px solid #1f1f1f" }}>
          <div style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "14px", color: "#39FF14", textShadow: "0 0 8px rgba(57,255,20,0.6)", letterSpacing: "1px" }}>
            BLOBSCAN
          </div>
          <div style={{ fontSize: "10px", color: "#666", marginTop: "8px" }}>Shelby Network</div>
        </div>

        {/* Nav */}
        <nav style={{ padding: "10px 0", flex: 1 }}>
          <a href="/" style={{ textDecoration: "none" }}>
            <div style={S.navItem(true)}>
              <NavIcon d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              Home
            </div>
          </a>
          <a href="/upload" style={{ textDecoration: "none" }}>
            <div style={S.navItem(false)}>
              <NavIcon d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              Upload
            </div>
          </a>
          <a href="https://explorer.shelby.xyz/shelbynet" target="_blank" style={{ textDecoration: "none" }}>
            <div style={S.navItem(false)}>
              <NavIcon d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              Explorer ↗
            </div>
          </a>
        </nav>

        <div style={{ padding: "12px 16px", borderTop: "1px solid #1f1f1f", fontSize: "10px", color: "#666" }}>
          by <a href="https://twitter.com/solscammer" target="_blank" style={{ color: "#666", textDecoration: "none" }}>@solscammer</a>
        </div>
      </aside>

      {/* ── Wallet — always fixed top-right ── */}
      <div style={{ position: "fixed", top: "12px", right: "24px", zIndex: 100, display: "flex", alignItems: "center", gap: "8px" }}>
        {connected ? (
          <>
            {walletAddress && (
              <button onClick={() => lookupAddress(walletAddress)} style={{ ...S.btnGreenOutline, fontSize: "12px", padding: "5px 10px" }}>My Wallet</button>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "5px 12px", fontSize: "12px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#39FF14", display: "inline-block", animation: "pulse-green 2s infinite" }} />
              <span style={{ color: "#aaa" }}>{walletAddress?.slice(0, 6)}…{walletAddress?.slice(-4)}</span>
            </div>
            <button onClick={() => disconnect()} style={{ ...S.btnOutline, padding: "5px 10px", fontSize: "12px" }}>Disconnect</button>
          </>
        ) : (
          <>
            {wallets.filter(w => w.name === "Petra").map(w => (
              <button key={w.name} onClick={() => connect(w.name)} style={{ ...S.btnGreen, padding: "5px 14px", fontSize: "12px" }}>Connect Petra</button>
            ))}
            {wallets.filter(w => w.name === "Petra").length === 0 && (
              <a href="https://petra.app" target="_blank" style={{ ...S.btnOutline, textDecoration: "none", padding: "5px 12px", fontSize: "12px" }}>Install Petra</a>
            )}
          </>
        )}
      </div>

      {/* ── Main ── */}
      <main style={S.main}>

        {/* Top bar with search — only when showing results */}
        {shown && (
          <header style={S.topbar}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", background: "#1a1a1a", border: "1px solid #242424", borderRadius: "8px", padding: "0 12px", height: "32px", width: "320px" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input value={addr} onChange={e => setAddr(e.target.value)} onKeyDown={e => e.key === "Enter" && lookup()}
                  placeholder="Search wallet (0x…)"
                  style={{ background: "transparent", border: "none", outline: "none", color: "#e5e5e5", fontSize: "12px", width: "100%", fontFamily: "inherit" }} />
              </div>
              <button onClick={lookup} style={{ ...S.btnGreen, padding: "5px 14px", fontSize: "12px" }}>Search</button>
            </div>
          </header>
        )}

        {/* ── Hero page — when not searching ── */}
        {!shown && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "72px 28px 80px", width: "100%" }}>

            {/* BLOBSCAN title */}
            <div style={{
              fontFamily: "'Press Start 2P', monospace",
              fontSize: "clamp(22px, 4vw, 52px)",
              color: "#39FF14",
              letterSpacing: "2px",
              marginBottom: "14px",
              textShadow: "0 0 10px #39FF14, 0 0 30px rgba(57,255,20,0.5), 0 0 60px rgba(57,255,20,0.2)",
              lineHeight: 1.4,
            }}>
              BLOBSCAN
            </div>
            <div style={{ fontSize: "13px", color: "#777", marginBottom: "24px" }}>Real blob explorer · Shelby Network</div>

            {/* Typewriter */}
            <div style={{ fontSize: "13px", color: "#666", minHeight: "22px", marginBottom: "28px" }}>
              <span ref={twRef} style={{ color: "#39FF14" }}></span>
              <span style={{ display: "inline-block", width: "2px", height: "14px", background: "#39FF14", marginLeft: "2px", verticalAlign: "middle", animation: "blink 0.8s step-end infinite", borderRadius: "1px" }}></span>
            </div>

            {/* Search bar */}
            <div style={{ display: "flex", gap: "8px", width: "100%", maxWidth: "500px", marginBottom: "36px" }}>
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "10px", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "10px", padding: "0 14px", height: "44px" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input value={addr} onChange={e => setAddr(e.target.value)} onKeyDown={e => e.key === "Enter" && lookup()}
                  placeholder="Enter wallet address (0x…)"
                  style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#e5e5e5", fontSize: "14px", fontFamily: "inherit" }} />
              </div>
              <button onClick={lookup} style={{ ...S.btnGreen, padding: "0 22px", fontSize: "14px" }}>Search</button>
            </div>

            {/* Upload CTA */}
            <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", borderColor: "#1f2a1f", width: "100%", maxWidth: "500px", textAlign: "left" }}>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "#e5e5e5", marginBottom: "3px" }}>Upload Files to Shelby Network</div>
                <div style={{ fontSize: "12px", color: "#888" }}>Connect Petra wallet · Decentralized hot storage · Sub-second retrieval</div>
              </div>
              <a href="/upload" style={{ ...S.btnGreen, textDecoration: "none", display: "inline-block" }}>Upload Files →</a>
            </div>
          </div>
        )}

        {/* Content — results + modals */}
        <div style={shown ? { ...S.content, maxWidth: "900px", width: "100%", margin: "0 auto" } : {}}>

          {/* Modals */}
          {modalSrc && (
            <div onClick={() => { URL.revokeObjectURL(modalSrc); setModalSrc(""); }}
              style={{ display: "flex", position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 999, cursor: "zoom-out", alignItems: "center", justifyContent: "center" }}>
              {modalType === "video" ? (
                <video src={modalSrc} controls playsInline style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: "10px" }}
                  onClick={e => e.stopPropagation()}
                  onError={e => { const v = e.currentTarget as HTMLVideoElement; alert(`Video error ${v.error?.code}: ${v.error?.message}`); }} />
              ) : modalType === "audio" ? (
                <div onClick={e => e.stopPropagation()} style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "14px", padding: "32px", textAlign: "center" }}>
                  <div style={{ fontSize: "48px", marginBottom: "16px" }}>🎵</div>
                  <audio src={modalSrc} controls autoPlay style={{ width: "280px" }}
                    onError={e => { const a = e.currentTarget as HTMLAudioElement; alert(`Audio error ${a.error?.code}`); }} />
                </div>
              ) : (
                <img src={modalSrc} style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: "10px" }} />
              )}
            </div>
          )}

          {decryptPrompt && (
            <div style={{ display: "flex", position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 1000, alignItems: "center", justifyContent: "center" }}>
              <div style={{ ...S.card, maxWidth: "400px", width: "90%", padding: "28px" }}>
                <div style={{ fontSize: "13px", color: "#39FF14", marginBottom: "4px", fontWeight: 600 }}>🔒 Encrypted Blob</div>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "14px" }}><span style={{ color: "#888" }}>{decryptPrompt.blobName}</span> may be encrypted.</div>
                <input value={decryptInput} onChange={e => setDecryptInput(e.target.value)} placeholder="Enter decryption key…"
                  onKeyDown={e => { if (e.key === "Enter" && decryptInput) { decryptPrompt.resolve(decryptInput); setDecryptPrompt(null); } }}
                  style={{ ...S.input, width: "100%", marginBottom: "14px" }} />
                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                  <button onClick={() => { decryptPrompt.resolve(null); setDecryptPrompt(null); }} style={S.btnOutline}>Skip</button>
                  <button onClick={() => { decryptPrompt.resolve(decryptInput || null); setDecryptPrompt(null); }}
                    disabled={!decryptInput} style={{ ...S.btnGreen, opacity: decryptInput ? 1 : 0.4 }}>Decrypt & Download</button>
                </div>
              </div>
            </div>
          )}

          {/* Banners */}
          {keyExpired && (
            <div style={{ background: "#1a0a0a", border: "1px solid #3a1515", borderRadius: "10px", padding: "14px 18px", marginBottom: "16px" }}>
              <span style={{ color: "#f87171", fontWeight: 600, fontSize: "13px" }}>🔒 Decryption Key Destroyed — </span>
              <span style={{ color: "#666", fontSize: "12px" }}>The key blob has expired on-chain.</span>
            </div>
          )}
          {linkConsumed && isOneDownload && !keyExpired && (
            <div style={{ background: "#1a0a0a", border: "1px solid #3a1515", borderRadius: "10px", padding: "14px 18px", marginBottom: "16px" }}>
              <span style={{ color: "#f87171", fontWeight: 600, fontSize: "13px" }}>⚡ Link Already Used — </span>
              <span style={{ color: "#666", fontSize: "12px" }}>This was a one-time download link.</span>
            </div>
          )}

          {/* Search results */}
          {shown && (
            <>
              {/* Balance */}
              <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
                <div style={{ ...S.card, flex: "0 0 auto", marginBottom: 0, minWidth: "160px" }}>
                  <div style={{ fontSize: "10px", color: "#444", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>APT Balance</div>
                  <div style={{ fontSize: "24px", fontWeight: 700, color: "#39FF14" }}>{loading ? "—" : apt}</div>
                </div>
                <div style={{ ...S.card, flex: "0 0 auto", marginBottom: 0, minWidth: "160px" }}>
                  <div style={{ fontSize: "10px", color: "#444", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>ShelbyUSD</div>
                  <div style={{ fontSize: "24px", fontWeight: 700, color: "#39FF14" }}>{loading ? "—" : usd}</div>
                </div>
                <div style={{ ...S.card, flex: 1, marginBottom: 0, minWidth: "220px" }}>
                  <div style={{ fontSize: "10px", color: "#444", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>Address</div>
                  <div style={{ fontSize: "12px", color: "#666", wordBreak: "break-all", fontFamily: "monospace" }}>{searchAddr}</div>
                </div>
              </div>

              {/* Files table */}
              <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
                {/* Table header */}
                <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 100px 160px 80px 120px", gap: "0", padding: "10px 16px", borderBottom: "1px solid #1f1f1f", background: "#161616" }}>
                  {["#", "FILE", "SIZE", "EXPIRES", "STATUS", "ACTIONS"].map(h => (
                    <div key={h} style={{ fontSize: "10px", fontWeight: 600, color: "#444", textTransform: "uppercase", letterSpacing: "1px" }}>{h}</div>
                  ))}
                </div>

                {blobsLoading ? (
                  <div style={{ padding: "40px", textAlign: "center", color: "#444", fontSize: "13px" }}>
                    <span style={{ display: "inline-block", width: "14px", height: "14px", border: "2px solid #2a2a2a", borderTop: "2px solid #39FF14", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginRight: "8px", verticalAlign: "middle" }} />
                    Loading blobs…
                  </div>
                ) : !accountBlobs || accountBlobs.length === 0 ? (
                  <div style={{ padding: "40px", textAlign: "center", color: "#444", fontSize: "13px" }}>No blobs found for this address.</div>
                ) : accountBlobs.map((blob, i) => {
                  const isImage = blob.blobNameSuffix.match(/\.(jpg|jpeg|png|gif|webp|jfif)$/i);
                  const isVideo = blob.blobNameSuffix.match(/\.(mp4|webm|mov)$/i);
                  const isAudio = blob.blobNameSuffix.match(/\.(mp3|wav|aac|m4a|flac|ogg)$/i);
                  const isExpired = blob.expirationMicros < Date.now() * 1000;
                  const explorerUrl = `https://explorer.shelby.xyz/shelbynet/account/${searchAddr}/blobs?name=${encodeURIComponent(blob.blobNameSuffix)}`;
                  const isHighlighted = highlightBlob === blob.blobNameSuffix;
                  if (isImage && !isExpired && !thumbnails[blob.blobNameSuffix]) loadThumbnail(blob.blobNameSuffix);
                  return (
                    <div key={i}>
                      <div style={{
                        display: "grid", gridTemplateColumns: "40px 1fr 100px 160px 80px 120px",
                        gap: 0, padding: "10px 16px", alignItems: "center",
                        borderBottom: i < accountBlobs.length - 1 ? "1px solid #1a1a1a" : "none",
                        background: isHighlighted ? "rgba(57,255,20,0.04)" : "transparent",
                        transition: "background 0.15s",
                      }}
                        onMouseEnter={e => { if (!isHighlighted) e.currentTarget.style.background = "#1f1f1f"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = isHighlighted ? "rgba(57,255,20,0.04)" : "transparent"; }}
                      >
                        {/* # */}
                        <div style={{ fontSize: "12px", color: "#333" }}>{i + 1}</div>

                        {/* File */}
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                          {isImage ? (
                            <div onClick={() => handlePreviewBlob(blob.blobNameSuffix)}
                              style={{ width: "32px", height: "32px", background: "#222", borderRadius: "6px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", cursor: "zoom-in", overflow: "hidden", flexShrink: 0 }}>
                              {thumbnails[blob.blobNameSuffix] ? <img src={thumbnails[blob.blobNameSuffix]} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : loadingThumbs.has(blob.blobNameSuffix) ? "⏳" : "🖼"}
                            </div>
                          ) : isVideo || isAudio ? (
                            <div onClick={() => handlePreviewBlob(blob.blobNameSuffix)}
                              style={{ width: "32px", height: "32px", background: "rgba(57,255,20,0.08)", borderRadius: "6px", border: "1px solid rgba(57,255,20,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", cursor: "pointer", flexShrink: 0 }}>
                              {previewLoading === blob.blobNameSuffix ? "⏳" : isAudio ? "🎵" : "▶️"}
                            </div>
                          ) : (
                            <div style={{ width: "32px", height: "32px", background: "#1f1f1f", borderRadius: "6px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", flexShrink: 0 }}>📄</div>
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: "13px", color: "#e5e5e5", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{blob.blobNameSuffix}</div>
                            <div style={{ fontSize: "11px", color: "#444", display: "flex", gap: "6px", flexWrap: "wrap" }}>
                              {isHighlighted && !linkConsumed && <span style={{ color: "#39FF14" }}>● Shared</span>}
                              {isHighlighted && isOneDownload && <span style={{ color: "#fb923c" }}>⚡ ONE-DL</span>}
                              {isHighlighted && linkConsumed && <span style={{ color: "#f87171" }}>CONSUMED</span>}
                            </div>
                          </div>
                        </div>

                        {/* Size */}
                        <div style={{ fontSize: "12px", color: "#666" }}>{formatSize(blob.size)}</div>

                        {/* Expires */}
                        <div style={{ fontSize: "11px", color: isExpired ? "#f87171" : "#555" }}>
                          {isExpired ? "Expired" : new Date(blob.expirationMicros / 1000).toLocaleDateString()}
                        </div>

                        {/* Status */}
                        <div style={{ fontSize: "11px" }}>
                          {blob.isDeleted ? <span style={{ color: "#f87171" }}>● Deleted</span>
                            : blob.isWritten ? <span style={{ color: "#39FF14" }}>● Ready</span>
                            : <span style={{ color: "#666" }}>● Pending</span>}
                        </div>

                        {/* Actions */}
                        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                          <a href={explorerUrl} target="_blank"
                            style={{ fontSize: "11px", color: "#444", textDecoration: "none", padding: "3px 8px", background: "#1f1f1f", border: "1px solid #2a2a2a", borderRadius: "5px" }}>↗</a>
                          {!isExpired && blob.isWritten && !(isHighlighted && linkConsumed) && (
                            <button onClick={() => handleDownload(blob.blobNameSuffix)} disabled={downloading === blob.blobNameSuffix}
                              style={{ fontSize: "11px", color: "#39FF14", background: "rgba(57,255,20,0.08)", border: "1px solid rgba(57,255,20,0.2)", borderRadius: "5px", padding: "3px 8px", cursor: "pointer", opacity: downloading === blob.blobNameSuffix ? 0.5 : 1, fontFamily: "inherit" }}>
                              {downloading === blob.blobNameSuffix ? "…" : "⬇"}
                            </button>
                          )}
                          {!isExpired && blob.isWritten && (isVideo || isAudio) && !(isHighlighted && linkConsumed) && (
                            <button onClick={async () => {
                              if (inlinePlayer === blob.blobNameSuffix) {
                                if (inlinePlayerUrl) URL.revokeObjectURL(inlinePlayerUrl);
                                setInlinePlayer(null); setInlinePlayerUrl(null); return;
                              }
                              setInlinePlayer(blob.blobNameSuffix); setInlinePlayerUrl(null);
                              try {
                                const dl = await shelbyClient.download({ account: searchAddr!, blobName: blob.blobNameSuffix });
                                const r = dl.readable.getReader(); const ch: Uint8Array[] = []; let len = 0;
                                while (true) { const { done, value } = await r.read(); if (done) break; ch.push(value); len += value.length; }
                                let d = new Uint8Array(len); let o = 0;
                                for (const c of ch) { d.set(c, o); o += c.length; }
                                let k = decryptKey;
                                if (!k && keyBlobName && searchAddr) {
                                  try {
                                    const kb = await shelbyClient.download({ account: searchAddr, blobName: keyBlobName });
                                    const kr = kb.readable.getReader(); const kc: Uint8Array[] = []; let kl = 0;
                                    while (true) { const { done, value } = await kr.read(); if (done) break; kc.push(value); kl += value.length; }
                                    const kd = new Uint8Array(kl); let ko = 0;
                                    for (const c of kc) { kd.set(c, ko); ko += c.length; }
                                    k = new TextDecoder().decode(kd);
                                  } catch {}
                                }
                                if (k) { try { d = await decryptData(d, k); } catch {} }
                                if (d.byteLength === 0) { alert("File is empty."); setInlinePlayer(null); return; }
                                const ext = blob.blobNameSuffix.split(".").pop()?.toLowerCase() || "";
                                const mimes: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg" };
                                setInlinePlayerUrl(URL.createObjectURL(new Blob([d], { type: mimes[ext] || "application/octet-stream" })));
                              } catch (e: any) { alert(`Play failed: ${e?.message}`); setInlinePlayer(null); }
                            }}
                              style={{ fontSize: "11px", color: inlinePlayer === blob.blobNameSuffix ? "#f87171" : "#a78bfa", background: "rgba(167,139,250,0.08)", border: `1px solid ${inlinePlayer === blob.blobNameSuffix ? "rgba(248,113,113,0.3)" : "rgba(167,139,250,0.2)"}`, borderRadius: "5px", padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>
                              {inlinePlayer === blob.blobNameSuffix && !inlinePlayerUrl ? "…" : inlinePlayer === blob.blobNameSuffix ? "■" : "▶"}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Inline player row */}
                      {inlinePlayer === blob.blobNameSuffix && inlinePlayerUrl && (
                        <div style={{ padding: "0 16px 12px", background: isHighlighted ? "rgba(57,255,20,0.04)" : "#111" }}>
                          {isVideo
                            ? <video src={inlinePlayerUrl} controls autoPlay playsInline style={{ width: "100%", maxHeight: "260px", borderRadius: "8px", background: "#000" }} />
                            : <audio src={inlinePlayerUrl} controls autoPlay style={{ width: "100%", borderRadius: "8px" }} />
                          }
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </main>

      {/* ── Fixed bottom network bar ── */}
      <div style={{ position: "fixed", bottom: 0, left: "190px", right: 0, zIndex: 40, background: "rgba(17,17,17,0.95)", borderTop: "1px solid #1f1f1f", padding: "0 24px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", gap: "16px", backdropFilter: "blur(8px)" }}>
        {netStatus ? (
          <>
            <span style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "11px" }}>
              <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#39FF14", display: "inline-block", animation: "pulse-green 2s infinite" }} />
              <span style={{ color: "#39FF14" }}>Online</span>
            </span>
            <span style={{ fontSize: "11px", color: "#666" }}>Block <span style={{ color: "#999" }}>{parseInt(netStatus.block_height).toLocaleString()}</span></span>
            <span style={{ fontSize: "11px", color: "#666" }}>TPS <span style={{ color: "#39FF14" }}>{netStatus.tps}</span></span>
            <a href="https://explorer.shelby.xyz/shelbynet" target="_blank" style={{ fontSize: "11px", color: "#777", textDecoration: "none", marginLeft: "4px" }}>explorer.shelby.xyz ↗</a>
          </>
        ) : (
          <span style={{ fontSize: "11px", color: "#777" }}>Connecting to Shelby Network…</span>
        )}
      </div>
    </div>
  );
}
