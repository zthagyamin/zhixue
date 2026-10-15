export const companionDownloads = {
  "schemaVersion": 1,
  "version": "1.42.2",
  "downloads": {
    "installer": {
      "filename": "Zhixue-Companion-Setup.exe",
      "url": "https://zhixue-downloads.zthagyamin.chatgpt.site/v1.42.2/Zhixue-Companion-Setup.exe",
      "sha256": "9af0465e4e3de872856ff48e50d1c5a0669cb945b79b7f1fdc41ef5facf964e5",
      "sizeBytes": 13629440
    },
    "portable": {
      "filename": "zhixue-companion-windows.zip",
      "url": "https://zhixue-portable-downloads.zthagyamin.chatgpt.site/v1.42.2/zhixue-companion-windows.zip",
      "sha256": "d4339f05b7d2cea9fccf017ed66c813c3e428f29c774cdda18e6b98d7eaf564b",
      "sizeBytes": 13616925
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
