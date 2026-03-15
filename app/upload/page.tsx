"use client";

import dynamic from "next/dynamic";

const UploadClient = dynamic(() => import("./UploadClient"), { ssr: false });

export default function UploadPage() {
  return <UploadClient />;
}
