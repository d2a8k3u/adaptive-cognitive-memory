"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TICKET_ID_SOURCE = void 0;
exports.isTicketShaped = isTicketShaped;
exports.TICKET_ID_SOURCE = "[A-Za-z0-9]{2,10}-\\d{1,6}";
const TICKET_SHAPE = new RegExp(`^${exports.TICKET_ID_SOURCE}$`);
function isTicketShaped(text) {
    return TICKET_SHAPE.test(text);
}
