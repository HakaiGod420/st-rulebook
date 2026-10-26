export class SlashCommand {
    static fromProps(props) {
        return new SlashCommand(props);
    }

    constructor(props) {
        Object.assign(this, props);
    }
}
