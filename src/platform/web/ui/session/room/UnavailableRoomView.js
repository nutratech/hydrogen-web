/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {TemplateView} from "../../general/TemplateView";

export class UnavailableRoomView extends TemplateView {
    render(t, vm) {
        return t.main({className: "UnknownRoomView middle"}, [
            t.div({className: "UnknownRoomView_header middle-header"}, [
                t.a({className: "button-utility close-middle", href: vm.closeUrl, title: vm.i18n`Close`}),
                t.h2(vm.i18n`Room unavailable`),
            ]),
            t.div({className: "UnknownRoomView_body centered-column"}, [
                t.div({className: "UnknownRoomView_container"}, [
                    t.h2(vm.i18n`The account that holds ${vm.roomId} is not connected right now.`),
                    t.p(vm.i18n`The room will open once that account reconnects.`),
                ]),
            ]),
        ]);
    }
}
