import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`create extension if not exists pg_trgm`.execute(db)
  await sql`create extension if not exists unaccent`.execute(db)
  // unaccent() is only STABLE, so it can't feed a generated column or index directly.
  // Pinning the dictionary makes this wrapper safe to declare IMMUTABLE.
  await sql`
    create or replace function f_unaccent(text) returns text
    language sql immutable parallel safe strict
    as $$ select unaccent('unaccent'::regdictionary, $1) $$
  `.execute(db)

  await db.schema
    .createTable('contacts')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('wa_id', 'text', (col) => col.notNull().unique())
    .addColumn('saved_name', 'text')
    .addColumn('profile_name', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('chats')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('contact_id', 'bigint', (col) =>
      col.notNull().unique().references('contacts.id').onDelete('cascade'),
    )
    .addColumn('last_message_at', 'timestamptz')
    .addColumn('last_inbound_at', 'timestamptz')
    .addColumn('last_outbound_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createIndex('chats_last_message_at_idx')
    .on('chats')
    .column('last_message_at desc')
    .execute()

  await db.schema
    .createTable('messages')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('wamid', 'text', (col) => col.notNull().unique())
    .addColumn('chat_id', 'bigint', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('direction', 'text', (col) => col.notNull().check(sql`direction in ('inbound', 'outbound')`))
    .addColumn('source', 'text', (col) => col.notNull().check(sql`source in ('live', 'history', 'echo')`))
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('text_body', 'text')
    .addColumn('media', 'jsonb')
    .addColumn('status', 'text')
    .addColumn('sent_at', 'timestamptz', (col) => col.notNull())
    .addColumn('raw', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('tsv', sql`tsvector`, (col) =>
      col.generatedAlwaysAs(sql`to_tsvector('spanish', f_unaccent(coalesce(text_body, '')))`).stored(),
    )
    .execute()
  await db.schema
    .createIndex('messages_chat_sent_at_idx')
    .on('messages')
    .columns(['chat_id', 'sent_at', 'id'])
    .execute()
  await sql`create index messages_tsv_idx on messages using gin (tsv)`.execute(db)

  await db.schema
    .createTable('webhook_events')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('processed_at', 'timestamptz')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .execute()
  await sql`create index webhook_events_pending_idx on webhook_events (id) where processed_at is null`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('webhook_events').execute()
  await db.schema.dropTable('messages').execute()
  await db.schema.dropTable('chats').execute()
  await db.schema.dropTable('contacts').execute()
  await sql`drop function if exists f_unaccent(text)`.execute(db)
}
