export function open(dialog) {
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        dialog.querySelector('[data-close-modal]')?.click();
    }, { once: true });
    dialog.showModal();
    dialog.querySelector('[data-close-modal]')?.focus();
}
