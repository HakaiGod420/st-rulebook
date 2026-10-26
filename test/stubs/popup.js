// Stub of SillyTavern's scripts/popup.js — the DOM shape matters, the logic not.

export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };

export class Popup {
    constructor(content, type = POPUP_TYPE.TEXT, inputValue = '', options = {}) {
        this.options = options;
        this.dlg = document.createElement('dialog');
        this.dlg.className = 'popup';
        this.dlg.innerHTML = `
            <div class="popup-body">
                <div class="popup-content"></div>
                <div class="popup-controls"><div class="menu_button">OK</div></div>
            </div>
            <div class="popup-button-close fa-solid fa-xmark" role="button" aria-label="Close"></div>`;
        this.content = this.dlg.querySelector('.popup-content');
        if (typeof content === 'string') {
            this.content.innerHTML = content;
        } else if (content) {
            this.content.append(content);
        }
    }

    show() {
        document.body.append(this.dlg);
        if (typeof this.dlg.showModal === 'function') {
            this.dlg.showModal();
        }
        window.__popupOpen = this;
        window.__popups = (window.__popups ?? 0) + 1;
        return new Promise(resolve => {
            this._resolve = resolve;
        });
    }

    complete(result = POPUP_RESULT.AFFIRMATIVE) {
        window.__popupOpen = null;
        this._resolve?.(result);
        this.dlg.close?.();
        this.dlg.remove();
    }
}

export async function callGenericPopup(text, type = POPUP_TYPE.CONFIRM) {
    window.__confirmText = text;
    window.__confirmCalls = (window.__confirmCalls ?? 0) + 1;
    return window.__confirmAnswer !== false;
}
