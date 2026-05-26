import { OAuthHelper } from './oauthHelper.js';
import { authStore } from '../storage/authStore.js';
import { db } from '../storage/db.js';

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_VIDEO_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const TIKTOK_VIDEO_STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const TIKTOK_USER_URL = 'https://open.tiktokapis.com/v2/user/info/';

export class TikTokAPI {
  async getConfig() {
    const clientKey = await db.getSetting('tiktok_client_key');
    const clientSecret = await db.getSetting('tiktok_client_secret');
    if (!clientKey) throw new Error('TikTok Client Key not configured. Go to Settings → API Keys.');
    return { clientKey, clientSecret };
  }

  async connect() {
    const { clientKey } = await this.getConfig();
    const state = OAuthHelper.generateRandomString(32);
    const { verifier, challenge } = await OAuthHelper.generatePKCE();

    await db.setSetting('tiktok_oauth_verifier', verifier);
    await db.setSetting('tiktok_oauth_state', state);

    const params = OAuthHelper.buildQueryString({
      client_key: clientKey,
      response_type: 'code',
      scope: 'user.info.basic,video.upload,video.publish',
      redirect_uri: OAuthHelper.getCallbackUrl(),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const authUrl = `${TIKTOK_AUTH_URL}?${params}`;
    const popup = OAuthHelper.openPopup(authUrl, 'Connect TikTok');
    const msg = await OAuthHelper.waitForOAuthMessage(popup, state);

    return this.exchangeCode(msg.code);
  }

  async exchangeCode(code) {
    const { clientKey, clientSecret } = await this.getConfig();
    const verifier = await db.getSetting('tiktok_oauth_verifier');

    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret || '',
      code,
      grant_type: 'authorization_code',
      redirect_uri: OAuthHelper.getCallbackUrl(),
      code_verifier: verifier,
    });

    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    const tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      open_id: data.open_id,
      expires_at: Date.now() + (data.expires_in || 86400) * 1000,
      scope: data.scope,
    };

    await authStore.setToken('tiktok', tokenData);
    await this.fetchUserInfo();
    return tokenData;
  }

  async refreshToken() {
    const token = await authStore.getToken('tiktok');
    if (!token?.refresh_token) throw new Error('No refresh token available');
    const { clientKey, clientSecret } = await this.getConfig();

    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret || '',
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    });

    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    await authStore.setToken('tiktok', {
      ...token,
      access_token: data.access_token,
      refresh_token: data.refresh_token || token.refresh_token,
      expires_at: Date.now() + (data.expires_in || 86400) * 1000,
    });
  }

  async getValidToken() {
    const token = await authStore.getToken('tiktok');
    if (!token) throw new Error('TikTok not connected');
    if (Date.now() > token.expires_at - 60000) {
      await this.refreshToken();
      return authStore.getToken('tiktok');
    }
    return token;
  }

  async fetchUserInfo() {
    const token = await this.getValidToken();
    const res = await fetch(`${TIKTOK_USER_URL}?fields=open_id,union_id,avatar_url,display_name,username`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const data = await res.json();
    if (data.error?.code && data.error.code !== 'ok') throw new Error(data.error.message);
    await db.setSetting('tiktok_user', JSON.stringify(data.data?.user || {}));
    return data.data?.user;
  }

  async publishVideo(videoBlob, caption, options = {}) {
    const token = await this.getValidToken();
    const { privacy = 'SELF_ONLY', allowComments = true, allowDuet = false } = options;

    const initRes = await fetch(TIKTOK_VIDEO_INIT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 150),
          privacy_level: privacy,
          disable_duet: !allowDuet,
          disable_comment: !allowComments,
          disable_stitch: true,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoBlob.size,
          chunk_size: videoBlob.size,
          total_chunk_count: 1,
        },
      }),
    });

    const initData = await initRes.json();
    if (initData.error?.code && initData.error.code !== 'ok') {
      throw new Error(initData.error.message || 'TikTok init failed');
    }

    const { publish_id, upload_url } = initData.data;

    const uploadRes = await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes 0-${videoBlob.size - 1}/${videoBlob.size}`,
        'Content-Type': 'video/mp4',
      },
      body: videoBlob,
    });

    if (!uploadRes.ok) throw new Error(`TikTok upload failed: ${uploadRes.status}`);

    return this.pollPublishStatus(token.access_token, publish_id);
  }

  async pollPublishStatus(accessToken, publishId, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(TIKTOK_VIDEO_STATUS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id: publishId }),
      });
      const data = await res.json();
      const status = data.data?.status;
      if (status === 'PUBLISH_COMPLETE') return { publishId, status, data };
      if (status === 'FAILED') throw new Error(`TikTok publish failed: ${JSON.stringify(data.data)}`);
    }
    throw new Error('TikTok publish status polling timed out');
  }

  async disconnect() {
    await authStore.removeToken('tiktok');
    await db.setSetting('tiktok_user', null);
  }
}

export const tiktokAPI = new TikTokAPI();
