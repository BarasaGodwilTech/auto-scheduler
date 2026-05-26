import { OAuthHelper } from './oauthHelper.js';
import { authStore } from '../storage/authStore.js';
import { db } from '../storage/db.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YT_CHANNEL_URL = 'https://www.googleapis.com/youtube/v3/channels';
const CHUNK_SIZE = 5 * 1024 * 1024;

export class YouTubeAPI {
  async getConfig() {
    const clientId = await db.getSetting('google_client_id');
    const clientSecret = await db.getSetting('google_client_secret');
    if (!clientId) throw new Error('Google Client ID not configured. Go to Settings → API Keys.');
    return { clientId, clientSecret };
  }

  async connect() {
    const { clientId } = await this.getConfig();
    const state = OAuthHelper.generateRandomString(32);
    const { verifier, challenge } = await OAuthHelper.generatePKCE();

    await db.setSetting('google_oauth_verifier', verifier);
    await db.setSetting('google_oauth_state', state);

    const params = OAuthHelper.buildQueryString({
      client_id: clientId,
      redirect_uri: OAuthHelper.getCallbackUrl(),
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const popup = OAuthHelper.openPopup(`${GOOGLE_AUTH_URL}?${params}`, 'Connect YouTube');
    const msg = await OAuthHelper.waitForOAuthMessage(popup, state);
    return this.exchangeCode(msg.code);
  }

  async exchangeCode(code) {
    const { clientId, clientSecret } = await this.getConfig();
    const verifier = await db.getSetting('google_oauth_verifier');

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret || '',
      redirect_uri: OAuthHelper.getCallbackUrl(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    const tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      scope: data.scope,
      token_type: data.token_type,
    };

    await authStore.setToken('youtube', tokenData);
    await this.fetchChannelInfo(tokenData.access_token);
    return tokenData;
  }

  async refreshToken() {
    const token = await authStore.getToken('youtube');
    if (!token?.refresh_token) throw new Error('No YouTube refresh token');
    const { clientId, clientSecret } = await this.getConfig();

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret || '',
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    await authStore.setToken('youtube', {
      ...token,
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    });
  }

  async getValidToken() {
    const token = await authStore.getToken('youtube');
    if (!token) throw new Error('YouTube not connected');
    if (Date.now() > token.expires_at - 60000) {
      await this.refreshToken();
      return authStore.getToken('youtube');
    }
    return token;
  }

  async fetchChannelInfo(accessToken) {
    const res = await fetch(
      `${YT_CHANNEL_URL}?part=snippet,statistics&mine=true&access_token=${accessToken}`
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const channel = data.items?.[0];
    if (channel) await db.setSetting('youtube_channel', JSON.stringify(channel));
    return channel;
  }

  async uploadShort(videoBlob, metadata, onProgress = null) {
    const token = await this.getValidToken();

    const videoMeta = {
      snippet: {
        title: metadata.title || 'Short',
        description: metadata.description || '',
        tags: metadata.tags || [],
        categoryId: metadata.categoryId || '22',
      },
      status: {
        privacyStatus: metadata.privacy || 'public',
        selfDeclaredMadeForKids: false,
      },
    };

    const initRes = await fetch(
      `${YT_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(videoBlob.size),
        },
        body: JSON.stringify(videoMeta),
      }
    );

    if (!initRes.ok) {
      const err = await initRes.json();
      throw new Error(err.error?.message || 'YouTube upload init failed');
    }

    const uploadUrl = initRes.headers.get('Location');
    if (!uploadUrl) throw new Error('YouTube did not return upload URL');

    return this.uploadChunked(uploadUrl, videoBlob, onProgress);
  }

  async uploadChunked(uploadUrl, videoBlob, onProgress = null) {
    const totalSize = videoBlob.size;
    let offset = 0;

    while (offset < totalSize) {
      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunk = videoBlob.slice(offset, end);

      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
          'Content-Type': 'video/mp4',
        },
        body: chunk,
      });

      if (res.status === 308) {
        const range = res.headers.get('Range');
        if (range) {
          offset = parseInt(range.split('-')[1]) + 1;
        } else {
          offset = end;
        }
        if (onProgress) onProgress(Math.round((offset / totalSize) * 100));
        continue;
      }

      if (res.ok) {
        const data = await res.json();
        if (onProgress) onProgress(100);
        return { videoId: data.id, data };
      }

      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || `YouTube chunk upload failed: ${res.status}`);
    }
  }

  async disconnect() {
    await authStore.removeToken('youtube');
    await db.setSetting('youtube_channel', null);
  }
}

export const youtubeAPI = new YouTubeAPI();
