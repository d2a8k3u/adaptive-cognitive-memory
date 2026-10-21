"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TICKET_ID_SOURCE = void 0;
exports.isTicketShaped = isTicketShaped;
exports.ticketId = ticketId;
const TICKET_PREFIX_CHAR = "[A-Za-z0-9]";
exports.TICKET_ID_SOURCE = `${TICKET_PREFIX_CHAR}{2,10}-\\d{1,6}`;
const TICKET_SHAPE = new RegExp(`^${exports.TICKET_ID_SOURCE}$`);
const TICKET_PATTERN = new RegExp(`(?<!${TICKET_PREFIX_CHAR})${exports.TICKET_ID_SOURCE}(?!\\d)`);
function isTicketShaped(text) {
    return TICKET_SHAPE.test(text);
}
function ticketId(branch) {
    if (branch === undefined) {
        return undefined;
    }
    return TICKET_PATTERN.exec(branch)?.[0].toUpperCase();
}
