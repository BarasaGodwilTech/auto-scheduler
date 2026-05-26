export class OAuthHelper {
  static generateRandomString(length = 64) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => chars[b % chars.length]).join('');
  }

  static async generatePKCE() {
    const verifier = this.generateRandomString(64);
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return { verifier, challenge };
  }

  static openPopup(url, title = 'OAuth', width = 600, height = 700) {
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    return window.open(url, title, `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`);
  }

  static waitForOAuthMessage(popup, expectedState, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('OAuth timed out after 2 minutes'));
      }, timeoutMs);

      const pollClosed = setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new Error('OAuth popup was closed by user'));
        }
      }, 500);

      function cleanup() {
        clearTimeout(timer);
        clearInterval(pollClosed);
        window.removeEventListener('message', handler);
      }

      function handler(event) {
        if (!event.data || event.data.type !== 'oauth_callback') return;
        if (event.data.state !== expectedState) return;
        cleanup();
        if (popup && !popup.closed) popup.close();
        if (event.data.error) {
          reject(new Error(event.data.error_description || event.data.error));
        } else {
          resolve(event.data);
        }
      }

      window.addEventListener('message', handler);
    });
  }

  static buildQueryString(params) {
    return Object.entries(params)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  static getCallbackUrl() {
    return `${window.location.origin}/auth/callback.html`;
  }
}
