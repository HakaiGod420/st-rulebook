export const registry = {};

export const SlashCommandParser = {
    addCommandObject(command) {
        registry[command.name] = command;
        return command;
    },
};
