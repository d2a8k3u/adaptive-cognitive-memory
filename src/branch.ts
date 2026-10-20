export const TICKET_ID_SOURCE = "[A-Za-z0-9]{2,10}-\\d{1,6}";

const TICKET_SHAPE = new RegExp(`^${TICKET_ID_SOURCE}$`);

export function isTicketShaped(text: string): boolean {
  return TICKET_SHAPE.test(text);
}
