/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {TemplateView} from "../../general/TemplateView";
import {CygnusStatus} from "../../../../../domain/session/settings/CygnusIdentityViewModel";

export class CygnusIdentityView extends TemplateView {
    render(t) {
        return t.div({className: "CygnusIdentityView"}, [
            t.map(vm => vm.status, (status, t, vm) => {
                switch (status) {
                    case CygnusStatus.Loading:
                        return t.p(vm.i18n`Loading…`);
                    case CygnusStatus.Unsupported:
                        return t.p(vm.i18n`Your homeserver does not support portable identities (tk.nutra.cygnus).`);
                    case CygnusStatus.NoIdentity:
                        return renderCreate(t, vm);
                    case CygnusStatus.Ready:
                        return renderIdentity(t, vm);
                }
            }),
            t.if(vm => vm.error, t => t.p({className: "error"}, vm => vm.error)),
        ]);
    }
}

function renderCreate(t, vm) {
    return t.div([
        t.p(vm.i18n`Create a portable identity: a principal that stays yours if you move homeservers. Its master key is your cross-signing master key, so set up cross-signing and unlock secret storage first.`),
        t.button({
            className: "button-action primary",
            disabled: vm => vm.isBusy,
            onClick: () => vm.createIdentity(),
        }, vm => vm.isBusy ? vm.i18n`Creating…` : vm.i18n`Create identity`),
    ]);
}

function renderIdentity(t, vm) {
    const row = (label, value) => t.div({className: "CygnusIdentityView_row"}, [
        t.strong(label), " ", t.code({className: "CygnusIdentityView_value"}, value),
    ]);
    return t.div([
        row(vm.i18n`Principal`, vm => vm.principal),
        row(vm.i18n`Shown as`, vm => vm.displayUserId),
        row(vm.i18n`Custodian`, vm => vm.custodian),
        row(vm.i18n`Chain height`, vm => String(vm.height)),
        row(vm.i18n`Signing device`, vm => vm.deviceId),
        t.p(vm => vm.hasPendingRotation
            ? vm.i18n`A key rotation was signed but your homeserver has not confirmed it. Retry to finish it.`
            : vm.i18n`Rotating signs the next link of your chain with the key your current link committed to, and commits to a fresh one.`),
        t.button({
            className: "button-action",
            disabled: vm => vm.isBusy,
            onClick: () => vm.rotate(),
        }, vm => vm.isBusy ? vm.i18n`Rotating…` : (vm.hasPendingRotation ? vm.i18n`Retry rotation` : vm.i18n`Rotate key`)),
    ]);
}
