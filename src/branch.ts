const TICKET_PREFIX_CHAR = "[A-Za-z0-9]";

export const TICKET_ID_SOURCE = `${TICKET_PREFIX_CHAR}{2,10}-\\d{1,6}`;

const TICKET_SHAPE = new RegExp(`^${TICKET_ID_SOURCE}$`);

const TICKET_PATTERN = new RegExp(`(?<!${TICKET_PREFIX_CHAR})${TICKET_ID_SOURCE}(?!\\d)`);

export function isTicketShaped(text: string): boolean {
  return TICKET_SHAPE.test(text);
}

export function ticketId(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  return TICKET_PATTERN.exec(branch)?.[0].toUpperCase();
}
