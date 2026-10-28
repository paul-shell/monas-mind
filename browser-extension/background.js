const receiver = 'http://127.0.0.1:47633/api/browser-capture';

let badgeTimer;
async function indicate(text, color, title) {
  clearTimeout(badgeTimer);
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await indicate('...', '#555555', 'Capturing page into Mona');
    if (!tab.id || !/^https?:/.test(tab.url || '')) throw new Error('Open an ordinary web page first.');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
      const copy = document.documentElement.cloneNode(true);
      const excluded = copy.querySelectorAll('script, iframe, frame, form, input, textarea, select, button, meta, [hidden]');
      const omitted = excluded.length;
      excluded.forEach(element => element.remove());
      for (const element of copy.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
          if (/^on/i.test(attribute.name) || ['srcdoc', 'value', 'data-token', 'data-secret'].includes(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
        }
      }
      const url = new URL(location.href);
      const videoId = /^(?:www\.|m\.)?youtube\.com$/i.test(url.hostname) && url.pathname === '/watch' ? url.searchParams.get('v') : null;
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) url.searchParams.set('v', videoId);
      let favicon = null;
      try {
        const iconUrl = document.querySelector('link[rel~="icon"]')?.href || new URL('/favicon.ico', location.origin).href;
        const icon = await fetch(iconUrl, { credentials: 'omit', signal: AbortSignal.timeout(2000) });
        const blob = await icon.blob();
        if (icon.ok && blob.size <= 262144 && blob.type.startsWith('image/')) {
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
          canvas.getContext('2d').drawImage(bitmap, 0, 0, 32, 32); bitmap.close();
          favicon = canvas.toDataURL('image/png');
        }
      } catch { /* A missing or cross-origin icon must not block the source. */ }
      return { title: document.title || url.hostname, url: url.href, html: '<!doctype html>\n' + copy.outerHTML, omitted, favicon };
    }});
    const config = await (await fetch(chrome.runtime.getURL('config.json'))).json();
    const response = await fetch(receiver, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mona-Capability': config.capability }, body: JSON.stringify(result), signal: AbortSignal.timeout(90000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Capture failed (${response.status}).`);
    await indicate('✓', '#168052', 'Saved to Sources');
    badgeTimer = setTimeout(() => indicate('', '#168052', "Mona's Mind"), 3000);
  } catch (error) {
    await indicate('!', '#b42318', `Capture failed: ${error.message}. Open Mona’s Mind first, then try again.`);
  }
});
