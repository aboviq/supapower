<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { useLiveQuery, useSupapowerStatus } from '@supapower/vue';

import { pg } from '../pglite.ts';
import type { Message } from '../schema.ts';
import MessageRow from './MessageRow.vue';

const props = defineProps<{
  userId: string;
  userName: string;
  leadership: string;
}>();

// Finds the database through `providePGlite` in the parent, and re-renders as
// rows arrive - whether typed in this tab, in another tab, or synced in from
// Supabase.
const { rows } = useLiveQuery.sql<Message>`
  SELECT * FROM messages ORDER BY created_at ASC, id ASC
`;
const { leading, connected, connecting, downloadError, uploadError } = useSupapowerStatus();

const draft = ref('');
const list = ref<HTMLUListElement | null>(null);

// Only the leading tab downloads, uploads and holds the realtime channel, so
// on a follower every other field stays false and says nothing useful.
const status = computed(() => {
  if (!leading.value) {
    return '○ follower · another tab is syncing';
  }

  if (connected.value) {
    return '● connected';
  }

  return connecting.value ? '○ connecting…' : '○ idle';
});

const error = computed(() => uploadError.value ?? downloadError.value);

watch(
  () => rows.value?.length,
  async () => {
    await nextTick();

    const el = list.value;

    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  },
);

async function send(): Promise<void> {
  const text = draft.value.trim();

  if (!text) {
    return;
  }

  draft.value = '';

  await pg.sql`
    INSERT INTO messages (id, user_id, user_name, message)
    VALUES (${crypto.randomUUID()}, ${props.userId}, ${props.userName}, ${text})
  `;
}
</script>

<template>
  <div class="chat">
    <ul ref="list" class="messages">
      <MessageRow
        v-for="message in rows ?? []"
        :key="message.id"
        :message="message"
        :is-own="message.user_id === userId"
      />
    </ul>
    <p :class="connected ? 'status connected' : 'status'">
      <span class="state">{{ status }}</span>
      <span v-if="error" class="error"> · {{ error.message }}</span>
      <span class="leadership"> · leadership: {{ leadership }}</span>
    </p>
    <form class="composer" @submit.prevent="send">
      <label>
        <span class="me">{{ userName }}:</span>
        <input v-model="draft" placeholder="Type a message and press Enter…" />
      </label>
      <button type="submit">Send</button>
    </form>
  </div>
</template>
