const maxDownloadBytes = 132 * 1024 * 1024;

async function chunks(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('下载响应为空');
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('下载内容超过大小限制，未保存文件');
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { parts, bytes };
}

export async function fetchDelivery(teamId, { token = '', apiBase = '', signal } = {}) {
  const headers = token ? { 'x-engine-token': token } : {};
  const response = await fetch(`${apiBase}/api/teams/${encodeURIComponent(teamId)}/delivery.zip`, {
    headers,
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    mode: 'same-origin',
    redirect: 'error',
  });
  if (!response.ok) {
    const { parts } = await chunks(response, 16384);
    let detail = '成果导出失败';
    try {
      const body = JSON.parse(await new Blob(parts).text());
      if (typeof body.error === 'string') detail = body.error;
    } catch {}
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/zip') {
    await response.body?.cancel();
    throw new Error('返回内容不是 ZIP，未保存文件');
  }
  const contentLength = response.headers.get('content-length');
  const deliveryBytes = response.headers.get('x-delivery-bytes');
  if (contentLength && deliveryBytes && contentLength !== deliveryBytes) {
    await response.body?.cancel();
    throw new Error('下载校验信息不一致，未保存文件');
  }
  const length = contentLength || deliveryBytes;
  const sha = response.headers.get('x-delivery-sha256');
  if (!length || !/^\d+$/.test(length) || Number(length) <= 0 || Number(length) > maxDownloadBytes || !sha || !/^[a-f0-9]{64}$/i.test(sha)) {
    await response.body?.cancel();
    throw new Error('下载校验信息无效或文件超限，未保存文件');
  }
  const { parts, bytes } = await chunks(response, maxDownloadBytes);
  if (bytes !== Number(length)) throw new Error('下载未完整接收，未保存文件');
  const blob = new Blob(parts, { type: 'application/zip' });
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== sha.toLowerCase()) throw new Error('下载校验不一致，未保存文件');
  const filename = /filename="([A-Za-z0-9._-]{1,150}\.zip)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'superagent-delivery.zip';
  return { blob, filename };
}
