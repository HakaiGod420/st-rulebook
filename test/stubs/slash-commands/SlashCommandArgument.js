export const ARGUMENT_TYPE = {
    STRING: 'string',
    NUMBER: 'number',
    RANGE: 'range',
    BOOLEAN: 'boolean',
    VARIABLE_NAME: 'variable',
    CLOSURE: 'closure',
    SUBCOMMAND: 'subcommand',
    LIST: 'list',
    DICTIONARY: 'dictionary',
};

export class SlashCommandArgument {
    static fromProps(props) {
        return props;
    }
}

export class SlashCommandNamedArgument {
    static fromProps(props) {
        return props;
    }
}
