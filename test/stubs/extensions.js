// Stub of SillyTavern's scripts/extensions.js for the local harness.

export const extension_settings = {};

const chat = [
    {
        name: 'Kisa',
        is_user: false,
        is_system: false,
        send_date: Date.now() - 60000,
        mes: '*The train is late and the platform lights are buzzing.*\n\nKisa is sitting on the bench with her knees pulled up, scrunchie around her wrist. "You took your time," she says, without looking up.',
        extra: {},
    },
    {
        name: 'Kai',
        is_user: true,
        is_system: false,
        send_date: Date.now() - 50000,
        mes: '"The bus broke down," I say, dropping onto the bench beside her.',
        extra: {},
    },
    {
        name: 'Kisa',
        is_user: false,
        is_system: false,
        send_date: Date.now() - 40000,
        mes: 'She pulls a transit card out of her shorts pocket and flicks it at me. "I have two rides left on this. You owe me one."',
        extra: {},
    },
];

let chatMetadata = {};

const listeners = new Map();

export const eventSource = {
    on(type, handler) {
        if (!listeners.has(type)) {
            listeners.set(type, []);
        }
        listeners.get(type).push(handler);
    },
    emit(type, ...args) {
        (listeners.get(type) ?? []).forEach(handler => handler(...args));
    },
};

export const eventTypes = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_changed',
    CHARACTER_SELECTED: 'character_selected',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SENT: 'message_sent',
    GENERATION_ENDED: 'generation_ended',
};

export function resetChatMetadata() {
    chatMetadata = {};
    window.__metaSaves = 0;
}

export function getContext() {
    return {
        characters: [{ name: 'Kisa', avatar: 'kisa.png' }],
        characterId: 0,
        chatId: 'harness-chat',
        chat,
        chatMetadata,
        maxContext: 12800,
        name1: 'Kai',
        name2: 'Kisa',
        getCurrentChatId: () => 'harness-chat',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'harness' }),
        saveMetadataDebounced: () => {
            window.__metaSaves = (window.__metaSaves || 0) + 1;
        },
        saveMetadata: () => {
            window.__metaSaves = (window.__metaSaves || 0) + 1;
        },
        eventSource,
        eventTypes,
    };
}

export async function renderExtensionTemplateAsync(extensionName, templateId) {
    const response = await fetch(`./mirror/scripts/extensions/${extensionName}/${templateId}.html`);
    if (!response.ok) {
        throw new Error(`Template not found: ${templateId}`);
    }
    return response.text();
}
