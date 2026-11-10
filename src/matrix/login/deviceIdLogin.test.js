/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {HomeServerApi} from "../net/HomeServerApi";
import {PasswordLoginMethod} from "./PasswordLoginMethod";
import {Registration} from "../registration/Registration";
import {Client} from "../Client.js";
import {Request as MockRequest} from "../../mocks/Request.js";

/** A request function that records each JSON body and answers with `respond(body)`. */
function recordingRequest(respond) {
    const bodies = [];
    const request = (url, options) => {
        const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
        bodies.push(body);
        const [status, response] = respond(body);
        return new MockRequest().respond(status, response);
    };
    return {request, bodies};
}

function client(request) {
    return new Client({request, loadOlm: () => undefined, loadOlmWorker: () => undefined});
}

const loginMethod = () => new PasswordLoginMethod({username: "alice", password: "pw", homeserver: "https://new.tld"});

export function tests() {
    return {
        "password login sends device_id only when one is requested": async assert => {
            const {request, bodies} = recordingRequest(() => [200, {}]);
            const hsApi = new HomeServerApi({homeserver: "https://hs.tld", request});
            await hsApi.passwordLogin("alice", "pw", "Hydrogen", {}, "HYDROGEN").response();
            await hsApi.passwordLogin("alice", "pw", "Hydrogen").response();
            assert.equal(bodies[0].device_id, "HYDROGEN");
            assert.equal("device_id" in bodies[1], false);
        },
        "logging in with a device ID returns credentials for that device": async assert => {
            const {request, bodies} = recordingRequest(body => [200, {
                device_id: body.device_id, user_id: "@alice:new.tld", access_token: "tok",
            }]);
            const credentials = await client(request).loginWithDeviceId(loginMethod(), "HYDROGEN");
            assert.equal(bodies[0].device_id, "HYDROGEN");
            assert.deepEqual(credentials, {
                deviceId: "HYDROGEN", userId: "@alice:new.tld", accessToken: "tok", homeserver: "https://new.tld",
            });
        },
        "logging in with a device ID refuses a server that assigns another one": async assert => {
            const {request} = recordingRequest(() => [200, {device_id: "OTHER", user_id: "@alice:new.tld", access_token: "tok"}]);
            await assert.rejects(client(request).loginWithDeviceId(loginMethod(), "HYDROGEN"), /expected HYDROGEN/);
        },
        "registration with a device ID refuses a server that assigns another one": async assert => {
            const responses = [];
            const hsApi = {
                register: (username, password, name, auth, inhibitLogin, options, deviceId) => {
                    responses.push(deviceId);
                    return {response: async () => ({device_id: "OTHER", user_id: "@alice:new.tld"}), responseCode: async () => 200};
                },
            };
            const registration = new Registration("https://new.tld", hsApi, {
                username: "alice", password: "pw", initialDeviceDisplayName: "Hydrogen", inhibitLogin: false, deviceId: "HYDROGEN",
            });
            const stage = {generateAuthenticationData: () => ({type: "m.login.dummy"})};
            await assert.rejects(registration.submitStage(stage), /expected HYDROGEN/);
            assert.equal(responses[0], "HYDROGEN");
        },
    };
}
