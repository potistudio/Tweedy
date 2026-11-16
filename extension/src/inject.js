/*
 * MAIN world で document_start に実行する。
 * ページの fetch / XMLHttpRequest をラップして X の API レスポンスを読み取り、
 * 抽出したツイートを window.postMessage で ISOLATED world の content.js へ送る。
 * ページ側の通信内容は改変せず、レスポンスの複製を読み取るのみとする。
 */
(() => {
  'use strict';
  if (window.__tvaultHooked) return;
  Object.defineProperty(window, '__tvaultHooked', { value: true });

  /*
   * content.js はアクションバーへボタンを挿入する前に、この CustomEvent を対象要素で同期的に発行する。
   * React のハイドレーション前の SSR 要素へ子要素を挿入すると、ハイドレーション不一致によりツイート全体が
   * クライアント側で再描画され、挿入したボタンが破棄される。
   * React のファイバー参照 (__reactFiber$*) を持たない要素に対しては preventDefault() で挿入の延期を通知する。
   * React の内部プロパティは MAIN world からのみ参照できるため、この判定は inject.js で行う。
   * parse.js の読み込み状態に依存しないため、parse.js が無い場合も登録する。
   */
  document.addEventListener('tvault:hydration-check', (e) => {
    const t = e.target;
    if (t && !Object.keys(t).some((k) => k.startsWith('__reactFiber$'))) e.preventDefault();
  }, true);

  const P = globalThis.TVaultParse;
  if (!P) return;

  const API_RE = /\/graphql\/|\/i\/api\//;

  function isApi(url) {
    return typeof url === 'string' && API_RE.test(url);
  }

  function extract(json) {
    let tweets;
    try {
      tweets = P.collectFromGraphql(json);
    } catch {
      return;
    }
    if (tweets.length) window.postMessage({ __tvault: 'tweets', tweets }, location.origin);
  }

  /*
   * レスポンスの走査はページ描画より優先度が低いため、メインスレッドのアイドル時間に実行する。
   * 待機中のタスクはレスポンス全体を保持するため、待機数が MAX_PENDING を超えた分は古い順に即時処理する。
   */
  const MAX_PENDING = 8;
  const queue = [];
  let scheduled = false;
  const schedule = typeof window.requestIdleCallback === 'function'
    ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 })
    : (fn) => setTimeout(fn, 0);

  function runTask(task) {
    try { task(); } catch { /* 個別タスクの失敗で後続を止めない */ }
  }

  function drain(deadline) {
    scheduled = false;
    while (queue.length && (!deadline || deadline.didTimeout || deadline.timeRemaining() > 2)) runTask(queue.shift());
    if (queue.length) {
      scheduled = true;
      schedule(drain);
    }
  }

  function enqueue(task) {
    queue.push(task);
    while (queue.length > MAX_PENDING) runTask(queue.shift());
    if (!scheduled) {
      scheduled = true;
      schedule(drain);
    }
  }

  function publish(json) {
    enqueue(() => extract(json));
  }

  function publishScriptText(text) {
    if (!text || !text.includes('full_text')) return;
    let tweets;
    try {
      tweets = P.collectFromScriptText(text);
    } catch {
      return;
    }
    if (tweets.length) window.postMessage({ __tvault: 'tweets', tweets }, location.origin);
  }

  /*
   * 初回表示のツイートは API 通信ではなく HTML 内の <script> に埋め込まれて届く。
   * ストリーミング描画の <script> は実行後に DOM から削除されるため、DOMContentLoaded 時点では残らない。
   * そのため document_start から MutationObserver で <script> の追加と削除を捕捉する。
   * HTML パーサーは <script> の挿入後に本文を分割して追加し得るため、パース中に追加された <script> は
   * 本文が確定する時点 (DOM からの削除時、または DOMContentLoaded) に読む。
   * パース完了後に追加された <script> は本文が確定しているため、追加時に読む。
   * 削除済みのノードも textContent は保持される。
   */
  const scannedScripts = new WeakSet();
  let parsingScripts = new Set();
  function readScript(s) {
    if (scannedScripts.has(s)) return;
    scannedScripts.add(s);
    parsingScripts.delete(s);
    const text = s.textContent;
    if (text && text.includes('full_text')) enqueue(() => publishScriptText(text));
  }
  function flushParsingScripts() {
    const list = parsingScripts;
    parsingScripts = new Set();
    for (const s of list) readScript(s);
  }
  // 画面遷移後に追加される <script> にも初期データが含まれ得るため、ページの存続中は監視を続ける。
  // 通知ごとの処理は addedNodes / removedNodes の nodeName 比較のみとする。
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeName !== 'SCRIPT') continue;
        if (document.readyState === 'loading') parsingScripts.add(n);
        else readScript(n);
      }
      for (const n of r.removedNodes) {
        if (n.nodeName === 'SCRIPT') readScript(n);
      }
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', flushParsingScripts, { once: true });

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const promise = origFetch.apply(this, args);
      let url = '';
      try {
        const input = args[0];
        url = typeof input === 'string' ? input : (input && input.url) || String(input);
      } catch { /* URL を判定できないリクエストは対象外とする */ }
      promise.then((res) => {
        const type = res.headers.get('content-type') || '';
        if (isApi(url) && type.includes('json')) res.clone().json().then(publish, () => {});
      }, () => {});
      return promise;
    };
  }

  const urls = new WeakMap();
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;

  XHR.open = function (method, url) {
    try { urls.set(this, String(url)); } catch { /* 記録失敗時は対象外とする */ }
    return origOpen.apply(this, arguments);
  };

  XHR.send = function () {
    if (isApi(urls.get(this))) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            publish(JSON.parse(this.responseText));
          } else if (this.responseType === 'json' && this.response) {
            publish(this.response);
          }
        } catch { /* JSON 以外のレスポンスは無視する */ }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
