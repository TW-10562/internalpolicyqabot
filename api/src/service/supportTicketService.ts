/**
 * Support Ticket Service
 * Handles user queries to admin and admin replies
 */
import { Op } from 'sequelize';
import { queryList, put, add } from '../utils/mapper';
import SupportTicket from '@/mysql/model/support_ticket.model';
import Notification from '@/mysql/model/notification.model';

interface CreateTicketData {
  userId: number;
  userName: string;
  departmentCode: string;
  subject: string;
  message: string;
}

interface ReplyTicketData {
  ticketId: number;
  adminId: number;
  adminName: string;
  departmentCode: string;
  reply: string;
  status?: 'in_progress' | 'resolved' | 'closed';
}

interface ListTicketsParams {
  pageNum: number;
  pageSize: number;
  userId?: number;
  departmentCode?: string;
  status?: string;
}

/**
 * Create a new support ticket from user
 */
export async function createSupportTicket(data: CreateTicketData) {
  try {
    const ticket = await add(SupportTicket, {
      user_id: data.userId,
      user_name: data.userName,
      department_code: data.departmentCode,
      subject: data.subject,
      message: data.message,
      status: 'open',
    });
    
    console.log(`[Support] New ticket created: ID ${ticket?.id} from user ${data.userName}`);
    return { success: true, ticketId: ticket?.id };
  } catch (error) {
    console.error('[Support] Failed to create ticket:', error);
    throw error;
  }
}

/**
 * Admin reply to a support ticket
 */
export async function replyToTicket(data: ReplyTicketData) {
  try {
    // Get the ticket
    const [ticket] = await queryList(SupportTicket, { id: { [Op.eq]: data.ticketId } });
    if (!ticket) {
      throw new Error('Ticket not found');
    }

    // Update ticket with admin reply
    await put(SupportTicket, { id: data.ticketId }, {
      admin_reply: data.reply,
      admin_id: data.adminId,
      admin_name: data.adminName,
      status: data.status || 'resolved',
      replied_at: new Date(),
    });

    // Create notification for the user
    await add(Notification, {
      user_id: ticket.user_id,
      department_code: data.departmentCode,
      title: 'Admin Reply to Your Query',
      message: `Your query "${ticket.subject}" has been answered by admin.`,
      type: 'admin_reply',
      is_read: false,
      related_id: data.ticketId,
    });

    console.log(`[Support] Ticket ${data.ticketId} replied by admin ${data.adminName}`);
    return { success: true };
  } catch (error) {
    console.error('[Support] Failed to reply to ticket:', error);
    throw error;
  }
}

/**
 * List support tickets (for admin or user)
 */
export async function listSupportTickets(params: ListTicketsParams) {
  try {
    const where: any = {};
    
    if (params.userId) {
      where.user_id = { [Op.eq]: params.userId };
    }
    if (params.departmentCode) {
      where.department_code = { [Op.eq]: params.departmentCode };
    }
    
    if (params.status) {
      where.status = { [Op.eq]: params.status };
    }

    const tickets = await queryList(SupportTicket, where);
    
    // Sort by created_at desc and paginate
    const sorted = tickets.sort((a: any, b: any) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    
    const start = (params.pageNum - 1) * params.pageSize;
    const paginated = sorted.slice(start, start + params.pageSize);
    
    return {
      rows: paginated,
      total: tickets.length,
      pageNum: params.pageNum,
      pageSize: params.pageSize,
    };
  } catch (error) {
    console.error('[Support] Failed to list tickets:', error);
    throw error;
  }
}

/**
 * Get user notifications
 */
export async function getUserNotifications(userId: number, unreadOnly = false, departmentCode?: string) {
  try {
    if (!userId) {
      return [];
    }
    const where: any = { user_id: { [Op.eq]: userId } };
    if (departmentCode) where.department_code = { [Op.eq]: departmentCode };
    if (unreadOnly) {
      where.is_read = { [Op.eq]: false };
    }
    
    const notifications = await queryList(Notification, where || {});
    
    // Sort by created_at desc
    return notifications.sort((a: any, b: any) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  } catch (error) {
    console.error('[Notification] Failed to get notifications:', error);
    throw error;
  }
}

/**
 * Mark notification as read
 */
export async function markNotificationRead(notificationId: number, userId: number) {
  try {
    await put(Notification, { 
      id: notificationId,
      user_id: { [Op.eq]: userId }
    }, {
      is_read: true,
    });
    return { success: true };
  } catch (error) {
    console.error('[Notification] Failed to mark as read:', error);
    throw error;
  }
}

/**
 * Get unread notification count
 */
export async function getUnreadCount(userId: number, departmentCode?: string) {
  try {
    const notifications = await queryList(Notification, {
      user_id: { [Op.eq]: userId },
      ...(departmentCode ? { department_code: { [Op.eq]: departmentCode } } : {}),
      is_read: { [Op.eq]: false },
    });
    return notifications.length;
  } catch (error) {
    console.error('[Notification] Failed to get unread count:', error);
    return 0;
  }
}
