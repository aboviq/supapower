<script setup lang="ts">
import { ref } from 'vue';

import { providePGlite } from '@supapower/vue';

import Chat from './components/Chat.vue';
import { pg } from './pglite.ts';

interface Identity {
  id: string;
  name: string;
}

defineProps<{ leadership: string }>();

const IDENTITY_KEY = 'supapower-chat:identity';

/**
 * Each tab is its own chat user: `sessionStorage` is per tab, where
 * `localStorage` would make every tab the same person.
 */
function loadIdentity(): Identity | null {
  try {
    const stored = sessionStorage.getItem(IDENTITY_KEY);

    return stored ? (JSON.parse(stored) as Identity) : null;
  } catch {
    // Storage blocked (private browsing, strict privacy settings) or the
    // stored value is corrupt - fall back to asking for a name again.
    return null;
  }
}

function saveIdentity(name: string): Identity {
  const identity: Identity = { id: crypto.randomUUID(), name };

  try {
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Same as above: the chat still works for this render, just without the
    // name surviving a reload.
  }

  return identity;
}

// Hands the database to `useLiveQuery` and `useSupapowerStatus` in `Chat`.
// This has to happen in a component's setup: `app.provide` cannot reach the
// injection key, which is private to `@electric-sql/pglite-vue`.
providePGlite(pg);

const identity = ref(loadIdentity());
const name = ref('');

function join(): void {
  const trimmed = name.value.trim();

  if (!trimmed) {
    return;
  }

  identity.value = saveIdentity(trimmed);
}
</script>

<template>
  <Chat
    v-if="identity"
    :user-id="identity.id"
    :user-name="identity.name"
    :leadership="leadership"
  />
  <form v-else class="join" @submit.prevent="join">
    <label>
      Your name:
      <input v-model="name" autofocus />
    </label>
    <button type="submit">Join the chat</button>
  </form>
</template>
