import { neon } from '@neondatabase/serverless';

// The neon client handles SSL and connection pooling automatically
const sql = neon(process.env.POSTGRES_URL!);

async function listInvoices() {
  const data = await sql`
    SELECT invoices.amount, customers.name
    FROM invoices
    JOIN customers ON invoices.customer_id = customers.id
    WHERE invoices.amount = 666;
  `;

  return data;
}

export async function GET() {
  try {
    const invoices = await listInvoices();
    return Response.json(invoices);
  } catch (error) {
    // In production, avoid returning the raw error object for security
    console.error('Database Error:', error);
    return Response.json({ error: 'Failed to fetch invoices' }, { status: 500 });
  }
}
