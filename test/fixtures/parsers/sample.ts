import { z } from "zod";

const InvoiceSchema = z.object({
  id: z.string(),
  customerEmail: z.string().email(),
  amountCents: z.number().int().positive(),
  currency: z.enum(["USD", "EUR", "GBP"]),
});

export type Invoice = z.infer<typeof InvoiceSchema>;

export class InvoiceQueue {
  private readonly pending: Invoice[] = [];

  enqueue(raw: unknown): void {
    const invoice = InvoiceSchema.parse(raw);
    this.pending.push(invoice);
  }

  drain(): Invoice[] {
    const drained = this.pending.slice();
    this.pending.length = 0;
    return drained;
  }
}

export function totalCents(invoices: Invoice[]): number {
  return invoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
}

export function isHighValue(invoice: Invoice, thresholdCents: number): boolean {
  return invoice.amountCents >= thresholdCents;
}
