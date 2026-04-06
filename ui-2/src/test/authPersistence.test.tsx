import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../App';

// ---------- mocks ----------

// Stub global fetch to prevent jsdom URL errors on relative paths
const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ code: 200, result: { messages: [] } }),
  json: async () => ({ code: 200, result: { messages: [] } }),
});
vi.stubGlobal('fetch', fetchMock);

// Mock the auth API module
vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth');
  return {
    ...actual,
    getMe: vi.fn(),
    getToken: vi.fn(),
    removeToken: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock health check to avoid side effects
vi.mock('../api/health', () => ({
  checkSystemHealth: vi.fn().mockResolvedValue({ llm: true, db: true }),
}));

// Mock Microsoft auth
vi.mock('../auth/microsoftAuth', () => ({
  logoutFromMicrosoft: vi.fn(),
  beginMicrosoftLoginRedirect: vi.fn(),
  completeMicrosoftLoginRedirect: vi.fn().mockResolvedValue(null),
  hasMicrosoftSsoConfig: vi.fn().mockReturnValue(false),
}));

// Mock notification APIs
vi.mock('../api/support', () => ({
  createSupportTicket: vi.fn(),
  getMyTickets: vi.fn().mockResolvedValue({ code: 200, result: { rows: [] } }),
  getNotifications: vi.fn().mockResolvedValue({ code: 200, result: [] }),
  markNotificationRead: vi.fn(),
}));

vi.mock('../api/notifications', () => ({
  listNotifications: vi.fn().mockResolvedValue({ ok: true, data: { rows: [] } }),
  markNotificationRead: vi.fn(),
}));

import { getMe, getToken, removeToken } from '../api/auth';

const mockedGetMe = vi.mocked(getMe);
const mockedGetToken = vi.mocked(getToken);
const mockedRemoveToken = vi.mocked(removeToken);

const validMeResponse = {
  code: 200,
  message: 'ok',
  result: {
    token: 'jwt-token',
    userId: 42,
    empId: 'EMP001',
    email: 'user@example.com',
    displayName: 'Test User',
    department: 'Human Resources',
    roleCode: 'USER' as const,
    departmentCode: 'HR' as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 200, result: { messages: [] } }),
    json: async () => ({ code: 200, result: { messages: [] } }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- helpers ----------

// The login page button text (Japanese is the default language)
const LOGIN_BUTTON = /microsoft/i;

// ---------- tests ----------

describe('Auth persistence across refresh', () => {
  it('restores a valid session without showing the login page', async () => {
    mockedGetToken.mockReturnValue('valid-jwt');
    mockedGetMe.mockResolvedValue(validMeResponse);

    const { container } = render(<App />);

    // While restoring, a loading spinner should be visible (not the login page)
    expect(container.querySelector('.animate-spin')).toBeTruthy();

    // After restoration completes, the login page should NOT appear
    await waitFor(() => {
      expect(container.querySelector('.animate-spin')).toBeFalsy();
    });
    expect(screen.queryByRole('button', { name: LOGIN_BUTTON })).not.toBeInTheDocument();

    // getMe was called exactly once
    expect(mockedGetMe).toHaveBeenCalledTimes(1);
    // Token was NOT removed (session is valid)
    expect(mockedRemoveToken).not.toHaveBeenCalled();
  });

  it('redirects to login when the session is invalid (401)', async () => {
    mockedGetToken.mockReturnValue('expired-jwt');
    mockedGetMe.mockResolvedValue({
      code: 401,
      message: 'Session expired, please login again',
    });

    render(<App />);

    // After the failed restoration, login page button should appear
    await waitFor(() => {
      expect(screen.getByRole('button', { name: LOGIN_BUTTON })).toBeInTheDocument();
    });

    // Stale token should be cleaned up
    expect(mockedRemoveToken).toHaveBeenCalled();
  });

  it('shows login immediately when no token exists (no flicker)', async () => {
    mockedGetToken.mockReturnValue(null);

    render(<App />);

    // Login page should render immediately — no loading state
    await waitFor(() => {
      expect(screen.getByRole('button', { name: LOGIN_BUTTON })).toBeInTheDocument();
    });

    // getMe should NOT be called when there's no token
    expect(mockedGetMe).not.toHaveBeenCalled();
    expect(mockedRemoveToken).not.toHaveBeenCalled();
  });

  it('restores admin users correctly', async () => {
    mockedGetToken.mockReturnValue('admin-jwt');
    mockedGetMe.mockResolvedValue({
      code: 200,
      message: 'ok',
      result: {
        ...validMeResponse.result,
        roleCode: 'SUPER_ADMIN',
        departmentCode: 'HR',
      },
    });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('.animate-spin')).toBeFalsy();
    });

    // Should not show login page
    expect(screen.queryByRole('button', { name: LOGIN_BUTTON })).not.toBeInTheDocument();
    expect(mockedGetMe).toHaveBeenCalledTimes(1);
    expect(mockedRemoveToken).not.toHaveBeenCalled();
  });

  it('cleans up token on network error', async () => {
    mockedGetToken.mockReturnValue('some-jwt');
    mockedGetMe.mockRejectedValue(new Error('Network error'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: LOGIN_BUTTON })).toBeInTheDocument();
    });

    expect(mockedRemoveToken).toHaveBeenCalled();
  });
});
