const MICROSOFT_GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me?$select=displayName,department,employeeId,mail,userPrincipalName,id';
const MICROSOFT_SCOPES = ['openid', 'profile', 'email', 'User.Read'];
const POPUP_FEATURES = 'popup=yes,width=520,height=720,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes';
const AUTH_MESSAGE_TYPE = 'microsoft-oauth-response';
const REDIRECT_RESPONSE_KEY = 'microsoft_sso_redirect_response';
const REDIRECT_STATE_KEY = 'microsoft_sso_state';
const REDIRECT_VERIFIER_KEY = 'microsoft_sso_verifier';

export interface MicrosoftUserInfo {
  displayName: string;
  department?: string | null;
  employeeId?: string | null;
  mail: string | null;
  userPrincipalName: string;
  id: string;
}

interface PopupResult {
  code: string;
  state: string;
}

type TokenExchangeResult = {
  accessToken: string;
  idToken?: string;
};

const getAzureClientId = () => (import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined)?.trim() || '';
const getAzureTenantId = () => (import.meta.env.VITE_AZURE_TENANT_ID as string | undefined)?.trim() || '';

export const hasMicrosoftSsoConfig = () => Boolean(getAzureClientId() && getAzureTenantId());

// Respect Vite base path (e.g. "/hrbot/") so redirect URIs work when hosted under a subpath.
const getRedirectUri = () => new URL(`${import.meta.env.BASE_URL || '/'}auth-popup.html`, window.location.origin).toString();

const base64UrlEncode = (input: ArrayBuffer | Uint8Array) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const createRandomString = (length = 64) => {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes).slice(0, length);
};

const createCodeChallenge = async (verifier: string) => {
  const data = new TextEncoder().encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
};

const buildAuthorizeUrl = async (state: string, nonce: string, codeVerifier: string) => {
  const tenantId = getAzureTenantId();
  const clientId = getAzureClientId();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
};

const consumeRedirectResponseSearch = () => {
  try {
    const search = window.sessionStorage.getItem(REDIRECT_RESPONSE_KEY) || '';
    if (search) {
      window.sessionStorage.removeItem(REDIRECT_RESPONSE_KEY);
    }
    return search;
  } catch {
    return '';
  }
};

const openPopup = (url: string) => {
  const popup = window.open(url, 'microsoft-sso', POPUP_FEATURES);
  if (!popup) {
    throw new Error('popup_blocked');
  }
  popup.focus();
  return popup;
};

const waitForPopupResult = (popup: Window, expectedState: string): Promise<PopupResult> =>
  new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', handleMessage);
      window.clearInterval(closePoll);
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== AUTH_MESSAGE_TYPE) return;

      const params = new URLSearchParams(String(event.data?.search || ''));
      const error = params.get('error');
      const state = params.get('state') || '';
      const code = params.get('code') || '';

      if (popup && !popup.closed) {
        popup.close();
      }

      if (error) {
        finish(() => reject(new Error(error)));
        return;
      }

      if (!state || state !== expectedState) {
        finish(() => reject(new Error('state_mismatch')));
        return;
      }

      if (!code) {
        finish(() => reject(new Error('missing_code')));
        return;
      }

      finish(() => resolve({ code, state }));
    };

    const closePoll = window.setInterval(() => {
      if (!popup || popup.closed) {
        finish(() => reject(new Error('user_cancelled')));
      }
    }, 500);

    window.addEventListener('message', handleMessage);
  });

const exchangeCodeForAccessToken = async (code: string, codeVerifier: string): Promise<TokenExchangeResult> => {
  const tenantId = getAzureTenantId();
  const clientId = getAzureClientId();
  const body = new URLSearchParams({
    client_id: clientId,
    scope: MICROSOFT_SCOPES.join(' '),
    code,
    redirect_uri: getRedirectUri(),
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const result = await response.json();
  if (!response.ok || result.error || !result.access_token) {
    throw new Error(result.error_description || result.error || 'token_exchange_failed');
  }

  return {
    accessToken: String(result.access_token),
    idToken: result.id_token ? String(result.id_token) : undefined,
  };
};

const storeRedirectFlowState = (state: string, codeVerifier: string) => {
  try {
    window.sessionStorage.setItem(REDIRECT_STATE_KEY, state);
    window.sessionStorage.setItem(REDIRECT_VERIFIER_KEY, codeVerifier);
  } catch {
    // Storage might be blocked; redirect flow won't be able to complete.
  }
};

const loadRedirectFlowState = () => {
  try {
    const state = window.sessionStorage.getItem(REDIRECT_STATE_KEY) || '';
    const verifier = window.sessionStorage.getItem(REDIRECT_VERIFIER_KEY) || '';
    return { state, verifier };
  } catch {
    return { state: '', verifier: '' };
  }
};

const clearRedirectFlowState = () => {
  try {
    window.sessionStorage.removeItem(REDIRECT_STATE_KEY);
    window.sessionStorage.removeItem(REDIRECT_VERIFIER_KEY);
  } catch {
    // ignore
  }
};

const parseJwtPayload = (token: string): Record<string, unknown> | null => {
  try {
    const payloadPart = String(token || '').split('.')[1] || '';
    if (!payloadPart) return null;
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
};

const extractStringClaim = (
  claims: Record<string, unknown> | null,
  exactKeys: string[],
  pattern: RegExp,
): string | null => {
  if (!claims) return null;

  for (const key of exactKeys) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  for (const [key, value] of Object.entries(claims)) {
    if (!pattern.test(key)) continue;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

const extractDepartmentFromClaims = (claims: Record<string, unknown> | null): string | null =>
  extractStringClaim(claims, ['department'], /department/i);

const extractEmployeeIdFromClaims = (claims: Record<string, unknown> | null): string | null =>
  extractStringClaim(claims, ['employeeId', 'employeeid'], /employee.?id/i);

const fetchMicrosoftUserInfo = async (accessToken: string, idToken?: string): Promise<MicrosoftUserInfo> => {
  const response = await fetch(MICROSOFT_GRAPH_ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('graph_profile_failed');
  }

  const profile = (await response.json()) as MicrosoftUserInfo;
  const tokenClaims = parseJwtPayload(String(idToken || ''));
  if (!String(profile.department || '').trim()) {
    const tokenDepartment = extractDepartmentFromClaims(tokenClaims);
    if (tokenDepartment) {
      profile.department = tokenDepartment;
    }
  }
  if (!String(profile.employeeId || '').trim()) {
    const tokenEmployeeId = extractEmployeeIdFromClaims(tokenClaims);
    if (tokenEmployeeId) {
      profile.employeeId = tokenEmployeeId;
    }
  }

  console.warn('[microsoftAuth.graph_profile]', {
    graphDepartment: String(profile.department || '').trim() || null,
    graphEmployeeId: String(profile.employeeId || '').trim() || null,
    displayName: String(profile.displayName || '').trim() || null,
    email: String(profile.mail || profile.userPrincipalName || '').trim() || null,
  });
  console.warn('[microsoftAuth.employee_probe]', {
    graphEmployeeId: String(profile.employeeId || '').trim() || null,
    email: String(profile.mail || profile.userPrincipalName || '').trim() || null,
  });

  return profile;
};

// Redirect-based login: starts an auth redirect (no popup).
// The redirect returns to /auth-popup.html, which stores the response in sessionStorage and navigates back to "/".
export async function beginMicrosoftLoginRedirect() {
  if (!window.crypto?.subtle) {
    throw new Error('webcrypto_unavailable');
  }

  if (!hasMicrosoftSsoConfig()) {
    throw new Error('sso_config_missing');
  }

  const state = createRandomString(32);
  const nonce = createRandomString(32);
  const codeVerifier = createRandomString(96);

  storeRedirectFlowState(state, codeVerifier);

  const authorizeUrl = await buildAuthorizeUrl(state, nonce, codeVerifier);
  window.location.assign(authorizeUrl);
}

// Redirect-based completion: call this after page load to finish the redirect flow if a response exists.
export async function completeMicrosoftLoginRedirect() {
  const search = consumeRedirectResponseSearch();
  if (!search) return null;

  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const error = params.get('error');
  const state = params.get('state') || '';
  const code = params.get('code') || '';

  if (error) {
    clearRedirectFlowState();
    throw new Error(error);
  }

  const stored = loadRedirectFlowState();
  if (!state || !stored.state || state !== stored.state) {
    clearRedirectFlowState();
    throw new Error('state_mismatch');
  }

  if (!code) {
    clearRedirectFlowState();
    throw new Error('missing_code');
  }

  if (!stored.verifier) {
    clearRedirectFlowState();
    throw new Error('missing_verifier');
  }

  try {
    const tokens = await exchangeCodeForAccessToken(code, stored.verifier);
    const userInfo = await fetchMicrosoftUserInfo(tokens.accessToken, tokens.idToken);
    return { accessToken: tokens.accessToken, userInfo };
  } finally {
    clearRedirectFlowState();
  }
}

export async function loginWithMicrosoftPopup() {
  if (!window.crypto?.subtle) {
    throw new Error('webcrypto_unavailable');
  }

  if (!hasMicrosoftSsoConfig()) {
    throw new Error('sso_config_missing');
  }

  const state = createRandomString(32);
  const nonce = createRandomString(32);
  const codeVerifier = createRandomString(96);
  const authorizeUrl = await buildAuthorizeUrl(state, nonce, codeVerifier);
  const popup = openPopup(authorizeUrl);
  const popupResult = await waitForPopupResult(popup, state);
  const tokens = await exchangeCodeForAccessToken(popupResult.code, codeVerifier);
  const userInfo = await fetchMicrosoftUserInfo(tokens.accessToken, tokens.idToken);

  return {
    accessToken: tokens.accessToken,
    userInfo,
  };
}

export function logoutFromMicrosoft() {
  const tenantId = getAzureTenantId();
  if (!tenantId) return;

  const params = new URLSearchParams({
    post_logout_redirect_uri: window.location.origin,
  });

  window.location.assign(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout?${params.toString()}`);
}
