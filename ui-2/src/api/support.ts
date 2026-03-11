/**
 * Support Ticket API for Contact Admin feature
 */
import request from './request';

interface CreateTicketData {
  subject: string;
  message: string;
}

interface TicketResponse {
  code: number;
  message: string;
  result?: any;
}

// Create a support ticket
export function createSupportTicket(data: CreateTicketData): Promise<TicketResponse> {
  return request('/api/support/ticket', {
    method: 'POST',
    data,
  });
}

// Get user's tickets
export function getMyTickets(params: { pageNum?: number; pageSize?: number; status?: string } = {}): Promise<TicketResponse> {
  const queryParams = new URLSearchParams();
  if (params.pageNum) queryParams.append('pageNum', params.pageNum.toString());
  if (params.pageSize) queryParams.append('pageSize', params.pageSize.toString());
  if (params.status) queryParams.append('status', params.status);
  
  return request(`/api/support/tickets?${queryParams.toString()}`, {
    method: 'GET',
  });
}

// Get notifications
export function getNotifications(unreadOnly = false): Promise<TicketResponse> {
  return request(`/api/support/notifications?unreadOnly=${unreadOnly}`, {
    method: 'GET',
  });
}

// Get unread notification count
export function getUnreadNotificationCount(): Promise<TicketResponse> {
  return request('/api/support/notifications/count', {
    method: 'GET',
  });
}

// Mark notification as read
export function markNotificationRead(notificationId: number): Promise<TicketResponse> {
  return request(`/api/support/notifications/${notificationId}/read`, {
    method: 'PUT',
  });
}

// Admin: Reply to ticket
export function replyToTicket(ticketId: number, data: { reply: string; status?: string }): Promise<TicketResponse> {
  return request(`/api/support/ticket/${ticketId}/reply`, {
    method: 'POST',
    data,
  });
}
