export const companionDownloads = {
  "schemaVersion": 1,
  "version": "1.41.1",
  "downloads": {
    "installer": {
      "filename": "Zhixue-Companion-Setup.exe",
      "url": "https://zhixue-downloads.zthagyamin.chatgpt.site/v1.41.1/Zhixue-Companion-Setup.exe",
      "sha256": "cfac7498346b80ffb415cf741bca34a74db8afc971bf677d37fb502eab0ba55d",
      "sizeBytes": 13526528
    },
    "portable": {
      "filename": "zhixue-companion-windows.zip",
      "url": "https://zhixue-portable-downloads.zthagyamin.chatgpt.site/v1.41.1/zhixue-companion-windows.zip",
      "sha256": "d8c5747e60b3017f775982dfeb7fa20f5ae67898bc1f4058545fc44bd2be140d",
      "sizeBytes": 13518842
    }
  }
};

/** Fixed release targets; request input never selects an external destination.
 * @param {"installer" | "portable"} kind
 */
export function companionDownloadRedirect(kind) {
  return new Response(null, {
    status: 307,
    headers: {
      Location: companionDownloads.downloads[kind].url,
      "Cache-Control": "public, max-age=300",
    },
  });
}

/** Resolve only legacy installer paths, before the framework's public-file index.
 * @param {Request} request
 * @returns {Response | null}
 */
export function resolveCompanionDownload(request) {
  const pathname = new URL(request.url).pathname;
  for (const kind of /** @type {const} */ (["installer", "portable"])) {
    if (pathname !== `/downloads/${companionDownloads.downloads[kind].filename}`) continue;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
      });
    }
    return companionDownloadRedirect(kind);
  }
  return null;
}
