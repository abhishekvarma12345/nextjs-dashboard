import bcrypt from 'bcrypt';
import postgres from 'postgres';
import { invoices, customers, revenue, users } from '../lib/placeholder-data';

export const runtime = 'nodejs';

type SqlClient = ReturnType<typeof postgres>;

type ConnectionCandidate = {
  name: string;
  value?: string;
  isDirect: boolean;
};

type ConnectionInfo = {
  connectionString: string;
  source: string;
  host: string;
  database: string;
  usingDirectConnection: boolean;
  usingPooledHost: boolean;
  derivedDirectConnection: boolean;
  removedChannelBinding: boolean;
};

type SeedSummary = {
  table: string;
  attempted: number;
  inserted: number;
};

type HealthCheckRow = {
  connected: number;
  current_database: string;
  current_user: string;
  server_time: string;
};

function createSqlClient(connectionInfo: ConnectionInfo) {
  return postgres(connectionInfo.connectionString, {
    ssl: 'require',
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    prepare: false,
  });
}

function stripChannelBinding(url: URL) {
  const removedChannelBinding = url.searchParams.has('channel_binding');
  url.searchParams.delete('channel_binding');
  return removedChannelBinding;
}

function buildConnectionInfo(): ConnectionInfo {
  const candidates: ConnectionCandidate[] = [
    {
      name: 'POSTGRES_URL_NON_POOLING',
      value: process.env.POSTGRES_URL_NON_POOLING,
      isDirect: true,
    },
    {
      name: 'DATABASE_URL_UNPOOLED',
      value: process.env.DATABASE_URL_UNPOOLED,
      isDirect: true,
    },
    {
      name: 'POSTGRES_URL',
      value: process.env.POSTGRES_URL,
      isDirect: false,
    },
    {
      name: 'DATABASE_URL',
      value: process.env.DATABASE_URL,
      isDirect: false,
    },
  ];

  const match = candidates.find((candidate) => candidate.value);

  if (!match?.value) {
    throw new Error(
      'No database connection string found. Set POSTGRES_URL_NON_POOLING, DATABASE_URL_UNPOOLED, POSTGRES_URL, or DATABASE_URL.',
    );
  }

  const url = new URL(match.value);
  const originallyPooled = url.hostname.includes('-pooler');
  let derivedDirectConnection = false;

  if (!match.isDirect && originallyPooled) {
    url.hostname = url.hostname.replace('-pooler.', '.');
    derivedDirectConnection = true;
  }

  const removedChannelBinding = stripChannelBinding(url);

  if (!url.searchParams.has('sslmode')) {
    url.searchParams.set('sslmode', 'require');
  }

  const usingPooledHost = url.hostname.includes('-pooler');

  return {
    connectionString: url.toString(),
    source: derivedDirectConnection
      ? `${match.name} (derived direct host)`
      : match.name,
    host: url.host,
    database: url.pathname.replace(/^\//, ''),
    usingDirectConnection: !usingPooledHost,
    usingPooledHost,
    derivedDirectConnection,
    removedChannelBinding,
  };
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    const details = error as Error & {
      code?: string;
      errno?: number;
      syscall?: string;
      severity?: string;
    };

    return {
      name: details.name,
      message: details.message,
      code: details.code,
      errno: details.errno,
      syscall: details.syscall,
      severity: details.severity,
    };
  }

  return {
    message: String(error),
  };
}

async function ensureUuidExtension(sql: SqlClient) {
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
}

async function runHealthCheck(sql: SqlClient) {
  const [row] = await sql<HealthCheckRow[]>`
    SELECT
      1 AS connected,
      current_database() AS current_database,
      current_user AS current_user,
      NOW()::text AS server_time
  `;

  return row;
}

async function seedUsers(sql: SqlClient): Promise<SeedSummary> {
  await ensureUuidExtension(sql);
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    );
  `;

  let inserted = 0;

  for (const user of users) {
    const hashedPassword = await bcrypt.hash(user.password, 10);
    const result = await sql`
      INSERT INTO users (id, name, email, password)
      VALUES (${user.id}, ${user.name}, ${user.email}, ${hashedPassword})
      ON CONFLICT (id) DO NOTHING;
    `;

    inserted += result.count;
  }

  return {
    table: 'users',
    attempted: users.length,
    inserted,
  };
}

async function seedCustomers(sql: SqlClient): Promise<SeedSummary> {
  await ensureUuidExtension(sql);
  await sql`
    CREATE TABLE IF NOT EXISTS customers (
      id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      image_url VARCHAR(255) NOT NULL
    );
  `;

  let inserted = 0;

  for (const customer of customers) {
    const result = await sql`
      INSERT INTO customers (id, name, email, image_url)
      VALUES (${customer.id}, ${customer.name}, ${customer.email}, ${customer.image_url})
      ON CONFLICT (id) DO NOTHING;
    `;

    inserted += result.count;
  }

  return {
    table: 'customers',
    attempted: customers.length,
    inserted,
  };
}

async function seedInvoices(sql: SqlClient): Promise<SeedSummary> {
  await ensureUuidExtension(sql);
  await sql`
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
      customer_id UUID NOT NULL,
      amount INT NOT NULL,
      status VARCHAR(255) NOT NULL,
      date DATE NOT NULL
    );
  `;

  let inserted = 0;

  for (const invoice of invoices) {
    const result = await sql`
      INSERT INTO invoices (customer_id, amount, status, date)
      SELECT ${invoice.customer_id}, ${invoice.amount}, ${invoice.status}, ${invoice.date}
      WHERE NOT EXISTS (
        SELECT 1
        FROM invoices
        WHERE customer_id = ${invoice.customer_id}
          AND amount = ${invoice.amount}
          AND status = ${invoice.status}
          AND date = ${invoice.date}
      );
    `;

    inserted += result.count;
  }

  return {
    table: 'invoices',
    attempted: invoices.length,
    inserted,
  };
}

async function seedRevenue(sql: SqlClient): Promise<SeedSummary> {
  await sql`
    CREATE TABLE IF NOT EXISTS revenue (
      month VARCHAR(4) NOT NULL UNIQUE,
      revenue INT NOT NULL
    );
  `;

  let inserted = 0;

  for (const rev of revenue) {
    const result = await sql`
      INSERT INTO revenue (month, revenue)
      VALUES (${rev.month}, ${rev.revenue})
      ON CONFLICT (month) DO NOTHING;
    `;

    inserted += result.count;
  }

  return {
    table: 'revenue',
    attempted: revenue.length,
    inserted,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const healthOnly =
    url.searchParams.get('health') === '1' ||
    url.searchParams.get('mode') === 'health';

  let sql: SqlClient | undefined;
  let connectionInfo: ConnectionInfo | undefined;
  const completedSteps: string[] = [];

  try {
    connectionInfo = buildConnectionInfo();
    sql = createSqlClient(connectionInfo);

    const healthCheck = await runHealthCheck(sql);
    completedSteps.push('health-check');

    if (healthOnly) {
      return Response.json({
        ok: true,
        mode: 'health',
        connection: connectionInfo,
        healthCheck,
      });
    }

    const seedResult = await sql.begin(async (tx) => {
      const seededUsers = await seedUsers(tx);
      completedSteps.push('users');

      const seededCustomers = await seedCustomers(tx);
      completedSteps.push('customers');

      const seededInvoices = await seedInvoices(tx);
      completedSteps.push('invoices');

      const seededRevenue = await seedRevenue(tx);
      completedSteps.push('revenue');

      return {
        users: seededUsers,
        customers: seededCustomers,
        invoices: seededInvoices,
        revenue: seededRevenue,
      };
    });

    return Response.json({
      ok: true,
      mode: 'seed',
      message: 'Database seeded successfully.',
      connection: connectionInfo,
      healthCheck,
      completedSteps,
      seedResult,
    });
  } catch (error) {
    console.error('Seed route failed', {
      connection: connectionInfo,
      completedSteps,
      error: serializeError(error),
    });

    return Response.json(
      {
        ok: false,
        connection: connectionInfo,
        completedSteps,
        error: serializeError(error),
      },
      { status: 500 },
    );
  } finally {
    if (sql) {
      await sql.end({ timeout: 5 });
    }
  }
}
