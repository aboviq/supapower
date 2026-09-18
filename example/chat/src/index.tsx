import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';

import { extensions, PGliteProvider, useLiveQuery, useSupapowerStatus } from '@supapower/react';

import { MESSAGES_TABLE_SQL, type Message } from './schema.js';

function askName(): string {
  for (;;) {
    const answer = prompt('Your name:')?.trim();

    if (answer) {
      return answer;
    }

    console.log('Please enter a name.');
  }
}

const supabaseUrl = Bun.env['SUPABASE_URL'];
const supabaseKey = Bun.env['SUPABASE_KEY'];

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY.');
  console.error('Copy .env.example to .env in this directory and fill them in.');
  process.exit(1);
}

const userName = askName();
const userId = Bun.randomUUIDv7();

console.log(`Welcome, ${userName}! Your user id is ${userId}.`);

const supabase = createClient(supabaseUrl, supabaseKey);

// No `fs` option: PGlite keeps everything in memory, so two terminals each
// start with an empty database and you can watch Supabase bring them in sync.
console.log('Starting PGlite (in memory)...');

const pg = await PGlite.create({ extensions });

console.log('Creating the local "messages" table:');
console.log(MESSAGES_TABLE_SQL);
await pg.exec(MESSAGES_TABLE_SQL);

console.log('Starting sync with Supabase...\n');

const sync = await pg.supapower.sync({
  supabase,
  // `access: 'anon'` because this demo has no sign in flow - see the README
  // for the Row Level Security policies that make that safe to try out.
  tables: [{ table: 'messages', access: 'anon' }],
});

function formatTime(value: Date): string {
  return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function MessageRow({ message, isOwn }: { message: Message; isOwn: boolean }) {
  return (
    <Box width="100%" justifyContent={isOwn ? 'flex-end' : 'flex-start'}>
      <Text wrap="truncate-end" {...(isOwn ? { color: 'cyan' as const } : {})}>
        {isOwn ? message.message : `${message.user_name}: ${message.message}`}{' '}
        <Text dimColor>{formatTime(message.created_at)}</Text>
      </Text>
    </Box>
  );
}

interface AppProps {
  pg: typeof pg;
  userId: string;
  userName: string;
}

function App({ pg: db, userId: myId, userName: myName }: AppProps) {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows);
  const { connected, connecting, downloadError, uploadError } = useSupapowerStatus();
  const lastError = uploadError ?? downloadError;
  const [input, setInput] = useState('');
  const results = useLiveQuery.sql<Message>`
    SELECT * FROM messages ORDER BY created_at ASC, id ASC
  `;
  const messages = results?.rows ?? [];

  useEffect(() => {
    const onResize = () => setRows(stdout.rows);

    stdout.on('resize', onResize);

    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const { exit } = useApp();

  // Ink's default `exitOnCtrlC` unmounts the app and resolves
  // `waitUntilExit()`, but a still-open Supabase realtime socket and pending
  // retry timers keep the process itself alive - handled below, after
  // `waitUntilExit()`. This just makes the intent explicit.
  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      exit();
    }
  });

  const handleSubmit = () => {
    const text = input.trim();

    if (!text) {
      return;
    }

    setInput('');

    void db.sql`
      INSERT INTO messages (id, user_id, user_name, message)
      VALUES (${Bun.randomUUIDv7()}, ${myId}, ${myName}, ${text})
    `;
  };

  const inputBoxRows = 3;
  const statusRows = 1;
  const messageBoxRows = Math.max(3, rows - inputBoxRows - statusRows);
  const visible = Math.max(0, messageBoxRows - 2);
  const shown = messages.slice(-visible);

  return (
    <Box flexDirection="column" height={rows}>
      <Box
        flexDirection="column"
        height={messageBoxRows}
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
        {shown.map((message) => (
          <MessageRow key={message.id} message={message} isOwn={message.user_id === myId} />
        ))}
      </Box>
      <Box height={statusRows}>
        <Text color={connected ? 'green' : 'yellow'}>
          {connected ? '● connected' : connecting ? '○ connecting…' : '○ idle'}
        </Text>
        {lastError ? <Text color="red"> · {lastError.message}</Text> : null}
      </Box>
      <Box borderStyle="round" borderColor="gray">
        <Text>{myName}: </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a message and press Enter…"
        />
      </Box>
    </Box>
  );
}

const { waitUntilExit } = render(
  <PGliteProvider db={pg}>
    <App pg={pg} userId={userId} userName={userName} />
  </PGliteProvider>,
);

await waitUntilExit();

// `process.exit` runs no asynchronous work, and the teardown is asynchronous:
// leaving the Supabase realtime channel is a round trip to the server. Awaiting
// it here is what makes the exit below clean - all it still has to do is cut
// short the pending retry timers that would otherwise keep the process alive.
await sync.unsubscribe();

process.exit(0);
