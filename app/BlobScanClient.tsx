"use client";
import { useState, useEffect, useRef } from "react";

export default function BlobScanClient() {
  const [addr, setAddr] = useState("");
  const [apt, setApt] = useState("");
  const [usd, setUsd] = useState("");
  const [address, setAddress] = useState("");
  const [blobSummary, setBlobSummary] = useState<{total: string, pending: number} | null>(null);
  const [blobs, setBlobs] = useState<{name: string, size: string, expires: string}[]>([]);
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [netStatus, setNetStatus] = useState<any>(null);
  const [recentEvents, setRecentEvents] = useState<{name: string, owner: string, time: string}[]>([]);
  const [modalSrc, setModalSrc] = useState("");
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
      "> Network status updates every 30 seconds",
      "> Blob uploads require APT for gas fees",
      "> Blobs expire based on the date set at upload",
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

  async function loadNetwork() {
    try {
      const r = await fetch("https://api.shelbynet.shelby.xyz/v1/");
      const d = await r.json();
      await new Promise(res => setTimeout(res, 1000));
      const r2 = await fetch("https://api.shelbynet.shelby.xyz/v1/");
      const d2 = await r2.json();
      const tps = (parseInt(d2.ledger_version) - parseInt(d.ledger_version)).toFixed(1);
      setNetStatus({ ...d2, tps, totalBlobs: "1,159,370+", totalStorage: "89.87 GB" });
      // Son event'leri çek
      try {
        const eq = `{ blob_events: blobs(limit: 5, order_by: { created_at: desc }) { blob_name owner created_at } }`;
        const er = await fetch("https://api.shelbynet.shelby.xyz/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: eq }) });
        const ed = await er.json();
        const events = ed?.data?.blob_events || [];
        setRecentEvents(events.map((e: any) => ({ name: e.blob_name, owner: e.owner, time: new Date(e.created_at).toLocaleTimeString() })));
      } catch {}
    } catch {}
  }

    async function lookup() {
    if (!addr.startsWith("0x")) { alert("Please enter a valid address starting with 0x"); return; }
    setLoading(true);
    setShown(true);
    try {
      const query = `{ current_fungible_asset_balances(where: {owner_address: {_eq: "${addr}"}}) { amount asset_type } }`;
      const r = await fetch("https://api.shelbynet.shelby.xyz/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      const data = await r.json();
      const balances = data.data?.current_fungible_asset_balances || [];
      const aptB = balances.find((b: any) => b.asset_type === "0x1::aptos_coin::AptosCoin");
      const usdB = balances.find((b: any) => b.asset_type.includes("1b18363"));
      setApt(aptB ? (aptB.amount / 100000000).toFixed(2) + " APT" : "0 APT");
      setUsd(usdB ? (usdB.amount / 100000000).toFixed(2) + " ShelbyUSD" : "0 ShelbyUSD");
      setAddress(addr);
    } catch {}
    try {
      const br = await fetch(`/api/blobs/${addr}`);
      const bdata = await br.json();
      const txt = bdata.raw || "";
      const lines = txt.split("\n").filter((l: string) => l.match(/\S+\.\S+\s+\d/));
      const parsed = lines.map((l: string) => {
        const parts = l.trim().split(/\s{2,}/);
        return { name: parts[0] || "", size: parts[1] || "", expires: parts.slice(2).join(" ") || "" };
      });
      setBlobs(parsed);
    } catch {}
    setLoading(false);
  }

  const card = { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "20px", marginBottom: "16px" } as const;

  return (
    <div style={{ fontFamily: "monospace", background: "#0f0f0f", color: "#e0e0e0", minHeight: "100vh", padding: "32px", paddingBottom: "120px", maxWidth: "800px", margin: "0 auto", position: "relative" }}>
      <canvas ref={canvasRef} style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", zIndex: -1, opacity: 0.08, pointerEvents: "none" }} />
      {modalSrc && (
        <div onClick={() => setModalSrc("")} style={{ display: "flex", position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.9)", zIndex: 999, cursor: "zoom-out", alignItems: "center", justifyContent: "center" }}>
          <img src={modalSrc} style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: "8px" }} />
        </div>
      )}
      <h1 style={{ color: "#7dd3a8", marginBottom: "4px" }}>BlobScan</h1>
      <div style={{ color: "#666", fontSize: "13px", marginBottom: "32px" }}>
      <div style={{ color: "#666", fontSize: "13px", marginBottom: "32px" }}>shelbynet</div>
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
            <div style={{ fontSize: "11px", color: "#444", wordBreak: "break-all", marginTop: "8px" }}>{address}</div>
          </div>
          <div style={card}>
            <h2 style={{ margin: "0 0 12px", fontSize: "13px", color: "#888", textTransform: "uppercase", letterSpacing: "1px" }}>Blob List</h2>
            {blobs.length === 0 ? (
              <div style={{ fontSize: "13px", color: "#444" }}>No blobs found.</div>
            ) : blobs.map((b, i) => {
              const isImage = b.name.match(/\.(jpg|jpeg|png|gif|webp|jfif)$/i);
              const downloadUrl = `/api/download/${addr}/${encodeURIComponent(b.name)}`;
              const explorerUrl = `https://explorer.shelby.xyz/shelbynet/account/${addr}/blobs?name=${encodeURIComponent(b.name)}`;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", borderBottom: "1px solid #2a2a2a", padding: "10px 0" }}>
                  {isImage ? (
                    <img src={downloadUrl} onClick={() => setModalSrc(downloadUrl)}
                      style={{ width: "40px", height: "40px", objectFit: "cover", borderRadius: "4px", border: "1px solid #2a2a2a", cursor: "zoom-in" }}
                      onError={e => (e.target as any).style.display = "none"} />
                  ) : (
                    <div style={{ width: "40px", height: "40px", background: "#111", borderRadius: "4px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px" }}>📄</div>
                  )}
                  <div style={{ flex: 1 }}>
                    <span style={{ color: "#a0c4ff", fontSize: "13px" }}>{b.name}</span>
                    <div style={{ color: "#555", fontSize: "11px" }}>{b.size}{b.expires ? ` · Expires: ${b.expires}` : ""}</div>
                  </div>
                  <a href={explorerUrl} target="_blank" style={{ color: "#555", fontSize: "11px", textDecoration: "none", padding: "4px 8px", border: "1px solid #2a2a2a", borderRadius: "4px", marginRight: "4px" }}>Explorer</a>
                  <a href={downloadUrl} download={b.name} style={{ color: "#7dd3a8", fontSize: "11px", textDecoration: "none", padding: "4px 8px", border: "1px solid #7dd3a8", borderRadius: "4px" }}>Download</a>
                </div>
              );
            })}
          </div>
        </>
      )}

      {recentEvents.length > 0 && (
        <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "20px", marginBottom: "16px" }}>
          <h2 style={{ margin: "0 0 12px", fontSize: "13px", color: "#888", textTransform: "uppercase" as const, letterSpacing: "1px" }}>Recent Network Events</h2>
          {recentEvents.map((e, i) => (
            <div key={i} style={{ borderBottom: "1px solid #2a2a2a", padding: "8px 0", fontSize: "12px" }}>
              <span style={{ color: "#a0c4ff" }}>{e.name}</span>
              <div style={{ color: "#555" }}>{e.owner.slice(0, 10)}...{e.owner.slice(-8)} · {e.time}</div>
            </div>
          ))}
        </div>
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
