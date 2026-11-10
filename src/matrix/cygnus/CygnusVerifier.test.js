/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {CygnusVerifier} from "./CygnusVerifier.js";
import {isCygnusRoomVersion, isPrincipal} from "./constants.js";

// Fixtures from the MSC00FC vectors (pid_vectors.json Appendix A, pid_pdu_vectors.json P1).
const A0 = "AQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC32MZixoPMgDH-lSweAJQcn7wcjfUdGTUZBVEiTTtvqmqNW7cPFLoVLxjAU0YFqLavtAcj1cyKgHHnxO_HKmR1ABBjaGF0LmV4YW1wbGUub3JnAAAAAG_Oo-n-u9BnYXdVjC4xpLfeuGi7cvjFrf24iMK3EQku5LSkOuOVnJrKDTTuxVHgam4m7iY-l6aCDwAZRhFWI08o6aqmw-ix8JnnN9Sxz3mdu9tuR0_8r3YhIkyctnefd92Md-_4qNlaLhz3yAQjl4JmbviRbIdRAdJ_XL2Kk8whSdmXscRO359YxeS_lGwC4_fEDY6dFUZCIA_uMTZE8YudfaVXfjWP3Fa6GDDWg5YqdzxNLt5YbFb5WhwFs1YsTVT7gBrpUjeqBn-XeIp8pr_PNjE5HdM4FZUSpJk3_ZylOZI_Tt5oxrE2JVFfhQXnVQAuOZSz7IUV_Y1AKRzGTbClGIi7vnUJJ4OexFgtG9qYr4vgzZlbVF5XXR3ragaaIh4SUVOdN7g4JnzAO1KFdqMzc_XRipWaJ1uMH-DwjkllhU1gksm5N3lXO5cuqQreZfETtHLfbSLiUqCeCDjKYhJO1DD8ONLeVJLQX_Ncrt2iCRAUVh_Yq3LEWmy4Yr36avypf44n4QGtrl8SLzsJFG9Vi0vDe48dYs9H9nb8o0rxu07U5h96sHvo4AATunhKV7jgHd1R_phT8xDoWbwXm25-hLSxmOU2amNk3RR1GjXcH7S4m9DVJtwWUrTce0qE1DDEGK-l6bf6kparu8O538OHy7CBmvCV1NZBBpVq7njFb4KNnTxMGWnKj97J_n4Uv627YVHKiql4I5z0D4rwhNybgqnEuJhl7GrsUtFX0O3iy4Wh0vnY0jXIkscS7STB6D-QsS8o3YWvBAotj3Z8Q-dL4VBY6E6MYxmr5g6Dw8eSnzWOpkFFKP25L2ZyCw26wKBEEYpRNF_R8x1NdQjJQokEaa36f66ZlRDFTCl3Q2Z7fzPiZSekfSVdgYKHgvsYxPA1XnN0q_tgftC21OJwaZSmtQK4U1EBRjN9giQ5Y8kN2ioZK5FfxWSpTlI19-F_8IzKcOOeqTuDtcPYCXlaqYVTXmst8mMqPZLMy43SXpa4sqK8wpkSqwA-zdYuPztNyqmmrrLemXZ1bOj15QaRKLlXZDFWTbRSRukGkIsKKi--zCqheEc5jwykFGzsv8_P5m816M4k_hQtm0LzQ-Ca67wM4xqvyp75AxjkEhPVlWbqQxegSxvpWzwfWgyK_4kHJ7-tWeKKiO5MhMkfagiCzGv0LamREaGpC8tjNZjFmGTo8GNuguTeo59gUTzDrv3TJccuztfG9ytGWLJJQUMYxHN2g7QWp5JozztQ7bErAKoA";
const A1 = "AQEIzW73lAdp9B8VbqetDRP74A_Wi-9pvs1NOeLC1r90TgAAAAAAAAABCM1u95QHafQfFW6nrQ0T--AP1ovvab7NTTniwta_dE6wdfTkEWCYXgSIe7HdNPlpNrXNPBWmPYsaJbyAxfg4sq15hxtiguLivt-gC29ohAVsiAi5TIGR-WB412_ij-0yABBjaGF0LmV4YW1wbGUub3Jn85cAv37PUhXUhvHXYSc9itGM8_oJThsvssCe8X9TjkMAAAAAsr7BLeAAtT6AgZvKp5KWDdXMVuZ03p_yVpJF6euHFXJbcx_wfe8fy4YkYQXHflmfkKcboyEbvKnr63Y6npVTy8lCJy0S7f4L8fhFGHovF9pxyR-oMslY3pm-TP3ZjRuRwF2LZ30tWEypqWCF7KVgIiaX7MiiCreHjutw4UihhmLWUq6JR5wglJOvLZLozZmnyLdeswPuabQFSLJ2pUz-J6dn5Q_BmVrkS8GPMqiZd4OW1CpQDgowMlaXbXC3lHLaaBtrTbIDf-HSTjlwghBuih5YBl1OS8R0eyJFyK_VItRZ4lMcZZc-kCSrrjz9eXZG2_e6dr6HDyts2WRhHaUjpJMLNHmbLC2ViCCgfSigju3YQpYi6ZKm9w5LWXzwVvCQr34RucDiAidoZNMs-MzFCX0ltVjQmhVZR_qpUkYRz0vq5qv9ialZMG10NWbQlLHW-rHwSQzrip8Bh4Xpk0ACHU9oVBTylCTgsW_ierT9YPVzfL3p7aOBjfvOqIGZppdiFYVrJm3keABro-uqNXsvSuWEExzfBjy352tXxgVh5EHCb-ymcW1A5Xo7La70zFAL5k9O9Xusd1xkVeCQqQE8w2mKl3KoBzK9496S5TKcaLtqP2Uihqc_dmHzPUDr5acymSGsVPo683r07dT2Kjm4mE_cThhEVfcfwqGANmg5SwzPhsHDrA35L9Ign3g5u-XnXnkpaICvTv7zfXi8VKVFEMM7PDoGJ7cCYeGpsRE0Xoke27k5k7CgySch9oLxTAr4uJL_RUC5pbLO-TQvNFv0Su4vOcscVKBeXcQ2a-Mfrn7IGR7OQaDuUwF6j-SNiNTULII4A7KnMMSVtO3MEHGesIQv-0Ms256Yx6RKYw9GhgUw55ovcUW2Nn_BEyvTnbelisVLZfHz2GYPty93KiFdzw6VdhUEfokS_MWyF-_6IRemtGBkDPhc8ssAnraVx6Of3BzT72gzbNCVKoKoprm41c4dS4P-lrEqRyAY4xeR7CYslJy5GHenjwa7Y0xVD4e8tmmrVwA428TfxxsmJ7MVdzWveMXczDdE05adLhUGX5Uj-9uBVBJQ74zKB7y83JeCgT67UTx6h0DmiZmGaxLc6WAkmkvzeZKBIDSHTchGkjkJKUglyO_wl-5kG0LnFJMpFnt3bXDYy907mLpknm1av3t615YtLIKVnbfMLNznFw2RCwlRl67Tm-yQIkxuSyml0sp3qww0lfA_H3W4mWNqB8O5zyZCKwpfF_u2zwq1BWg";
const CREATE_PDU = {"type":"m.room.create","sender":"@gz3Kb2QKGA29cL72NzTni3OosF9dYQmNPkYtea21eIQ","content":{"room_version":"tk.nutra.cygnus.1","creator_links":{"server":["AQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC32MZixoPMgDH-lSweAJQcn7wcjfUdGTUZBVEiTTtvqmqNW7cPFLoVLxjAU0YFqLavtAcj1cyKgHHnxO_HKmR1ABBjaGF0LmV4YW1wbGUub3JnAAAAAG_Oo-n-u9BnYXdVjC4xpLfeuGi7cvjFrf24iMK3EQku5LSkOuOVnJrKDTTuxVHgam4m7iY-l6aCDwAZRhFWI08o6aqmw-ix8JnnN9Sxz3mdu9tuR0_8r3YhIkyctnefd92Md-_4qNlaLhz3yAQjl4JmbviRbIdRAdJ_XL2Kk8whSdmXscRO359YxeS_lGwC4_fEDY6dFUZCIA_uMTZE8YudfaVXfjWP3Fa6GDDWg5YqdzxNLt5YbFb5WhwFs1YsTVT7gBrpUjeqBn-XeIp8pr_PNjE5HdM4FZUSpJk3_ZylOZI_Tt5oxrE2JVFfhQXnVQAuOZSz7IUV_Y1AKRzGTbClGIi7vnUJJ4OexFgtG9qYr4vgzZlbVF5XXR3ragaaIh4SUVOdN7g4JnzAO1KFdqMzc_XRipWaJ1uMH-DwjkllhU1gksm5N3lXO5cuqQreZfETtHLfbSLiUqCeCDjKYhJO1DD8ONLeVJLQX_Ncrt2iCRAUVh_Yq3LEWmy4Yr36avypf44n4QGtrl8SLzsJFG9Vi0vDe48dYs9H9nb8o0rxu07U5h96sHvo4AATunhKV7jgHd1R_phT8xDoWbwXm25-hLSxmOU2amNk3RR1GjXcH7S4m9DVJtwWUrTce0qE1DDEGK-l6bf6kparu8O538OHy7CBmvCV1NZBBpVq7njFb4KNnTxMGWnKj97J_n4Uv627YVHKiql4I5z0D4rwhNybgqnEuJhl7GrsUtFX0O3iy4Wh0vnY0jXIkscS7STB6D-QsS8o3YWvBAotj3Z8Q-dL4VBY6E6MYxmr5g6Dw8eSnzWOpkFFKP25L2ZyCw26wKBEEYpRNF_R8x1NdQjJQokEaa36f66ZlRDFTCl3Q2Z7fzPiZSekfSVdgYKHgvsYxPA1XnN0q_tgftC21OJwaZSmtQK4U1EBRjN9giQ5Y8kN2ioZK5FfxWSpTlI19-F_8IzKcOOeqTuDtcPYCXlaqYVTXmst8mMqPZLMy43SXpa4sqK8wpkSqwA-zdYuPztNyqmmrrLemXZ1bOj15QaRKLlXZDFWTbRSRukGkIsKKi--zCqheEc5jwykFGzsv8_P5m816M4k_hQtm0LzQ-Ca67wM4xqvyp75AxjkEhPVlWbqQxegSxvpWzwfWgyK_4kHJ7-tWeKKiO5MhMkfagiCzGv0LamREaGpC8tjNZjFmGTo8GNuguTeo59gUTzDrv3TJccuztfG9ytGWLJJQUMYxHN2g7QWp5JozztQ7bErAKoA","AQEIzW73lAdp9B8VbqetDRP74A_Wi-9pvs1NOeLC1r90TgAAAAAAAAABCM1u95QHafQfFW6nrQ0T--AP1ovvab7NTTniwta_dE6wdfTkEWCYXgSIe7HdNPlpNrXNPBWmPYsaJbyAxfg4sq15hxtiguLivt-gC29ohAVsiAi5TIGR-WB412_ij-0yABBjaGF0LmV4YW1wbGUub3Jn85cAv37PUhXUhvHXYSc9itGM8_oJThsvssCe8X9TjkMAAAAAsr7BLeAAtT6AgZvKp5KWDdXMVuZ03p_yVpJF6euHFXJbcx_wfe8fy4YkYQXHflmfkKcboyEbvKnr63Y6npVTy8lCJy0S7f4L8fhFGHovF9pxyR-oMslY3pm-TP3ZjRuRwF2LZ30tWEypqWCF7KVgIiaX7MiiCreHjutw4UihhmLWUq6JR5wglJOvLZLozZmnyLdeswPuabQFSLJ2pUz-J6dn5Q_BmVrkS8GPMqiZd4OW1CpQDgowMlaXbXC3lHLaaBtrTbIDf-HSTjlwghBuih5YBl1OS8R0eyJFyK_VItRZ4lMcZZc-kCSrrjz9eXZG2_e6dr6HDyts2WRhHaUjpJMLNHmbLC2ViCCgfSigju3YQpYi6ZKm9w5LWXzwVvCQr34RucDiAidoZNMs-MzFCX0ltVjQmhVZR_qpUkYRz0vq5qv9ialZMG10NWbQlLHW-rHwSQzrip8Bh4Xpk0ACHU9oVBTylCTgsW_ierT9YPVzfL3p7aOBjfvOqIGZppdiFYVrJm3keABro-uqNXsvSuWEExzfBjy352tXxgVh5EHCb-ymcW1A5Xo7La70zFAL5k9O9Xusd1xkVeCQqQE8w2mKl3KoBzK9496S5TKcaLtqP2Uihqc_dmHzPUDr5acymSGsVPo683r07dT2Kjm4mE_cThhEVfcfwqGANmg5SwzPhsHDrA35L9Ign3g5u-XnXnkpaICvTv7zfXi8VKVFEMM7PDoGJ7cCYeGpsRE0Xoke27k5k7CgySch9oLxTAr4uJL_RUC5pbLO-TQvNFv0Su4vOcscVKBeXcQ2a-Mfrn7IGR7OQaDuUwF6j-SNiNTULII4A7KnMMSVtO3MEHGesIQv-0Ms256Yx6RKYw9GhgUw55ovcUW2Nn_BEyvTnbelisVLZfHz2GYPty93KiFdzw6VdhUEfokS_MWyF-_6IRemtGBkDPhc8ssAnraVx6Of3BzT72gzbNCVKoKoprm41c4dS4P-lrEqRyAY4xeR7CYslJy5GHenjwa7Y0xVD4e8tmmrVwA428TfxxsmJ7MVdzWveMXczDdE05adLhUGX5Uj-9uBVBJQ74zKB7y83JeCgT67UTx6h0DmiZmGaxLc6WAkmkvzeZKBIDSHTchGkjkJKUglyO_wl-5kG0LnFJMpFnt3bXDYy907mLpknm1av3t615YtLIKVnbfMLNznFw2RCwlRl67Tm-yQIkxuSyml0sp3qww0lfA_H3W4mWNqB8O5zyZCKwpfF_u2zwq1BWg"],"user":["AQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANMhgFO5LSdHNG32ouHJPo0soEo_ZrPbLP1C_iSBDikwjNbveUB2n0HxVup60NE_vgD9aL72m-zU054sLWv3ROAYSWaqhLlQ0giOXvaOKmPSqnW0jEupZC1k9vuWQzGLszABdAYWxpY2U6Y2hhdC5leGFtcGxlLm9yZw"]}},"origin_server_ts":1792860000001,"depth":1,"prev_events":[],"auth_events":[],"state_key":"","device_certificate":{"version":1,"device_id":"TEST51","device_key":"gYM7DxrnyMxOsLCBBydpyLyoyERxfDEaXoL_TPpJFyk","self_signing_key":"7jLYBuGl_yVmQqKjX_Kg7qLbeE0pnebh1KVH3Mz31AA","self_signing_signature":"AAAAAOqP1pe6_vCe-yKfnPorMGZ8HXexknhvck2N71q3S9UVcC5VJJbCcbYTdL-2RdVslCPwa8ivQqPWBJh2uSVSAXjAiZBUBLy6qo5_8uvMu5CCDpwsQiq9yqk46U2LAXnqGHn-e2vuYO2hY_8guzKM2UWKIB70rwL-7dN2LhrUxEFP415_lZDsvRBKYnuRG17w6_jfgFHt7p9wKolM6q_GyeUrUbmT7Mze864FcRN35h4-iWmQqmVwLr_7_9dLMjertgHSQJ6ewNQ8FT_03ykPjsHBXzyltR2WhHbYbsifSjNRre9CVeJGZjfP2RXlMhzSVugucumMnVZdZd3s8UVKCOuaKkOeUVRgw_zqg_YxHkixnVdHkc7bx3SEk_WfzqcqZHkWSyyg9DiYaAfqa7YUr4FwoJC_nCU_4yBwONytN39enpCDeY2CcyPAkYl4cltqUPW4pmCVuo4wNbq9VXdNaKqbDXrB1dYvFw0XS-OJQuXVPEJ4_9GwSdVXr_9PZlHR7rqj9A0UTprrLm85v3WcjzZEsSJv7NhsoviEWH-7ZHhx_wrs_VDOLp1cJPD4DVg_S0IyPl9nazFsH1HyubVprCxSbAP8Mxj5vEba_9q9zpr2XQpEPAv0RiibHU8Vi_4_obGC4McycUneeBbTr9k3LMGZmb7HMaB6GyNjtQMUhjnibuDaGXhQSgheA1BsMRqmJZ58Sl5-XjM-NZJZQ38Lhe4YbaQslLzvVwpo08Nu4J6HmOD5J9CH3KGapfEJ8pi-Yx2bSp_A88vPW9MBp-qpmwLZGdcteWfwza42u3p_X3yKhPZ_wIKO-2OAzL6XiInilkPnWV4VFrNXgIk3gQ3wG4Eg0gmdhQ6QIIjQx_obid-wYO-ErIqxYlgpvK-mVf0VEUnb7C4PbhcymEssbRFyHWwdFGh8fGNthpWxWz6dBjWnAyptfMBMLTrKoFqbuaOkdOBHjLrBFL4nXrWDCDVFS-UrKwaeVmHaP2oBJ6TzGuSX1I4raGtoTzRIbErOgvdOY7-ur_g4dwfOZU5bOoFwpGt-ZrHZfiMJKWqCygqU3fJJerSRN5m6nNyTeB3cWvzga6tOi0L_wdaPD5VjjRCthbILS5xoq9GHXYv1HVripIZfGkeXTRjZGoruFGCLJcI49l7Cf7rVIb7BAHgU8Gfe0j2Ke2HIJTQmm61a3r111IClEwKB9Z3g_J2ydy_WoLzav-GBvxGn2wE-C0eVt1FUW20JLZ4BUB_PhyfGd4a2QOqP","device_key_signature":"AAAAAAiku_ch_x8ZFwAko6hFKprbbpSpr-z4inCBQsIMET1uXiVf0rISapz7ZFAjNdpZDbmAFZtqIG4yGC1zJsOIwGjvPog9nW0JrXchPQXDGBFgkl4SnA216j8f2OolX0g9XkUWsVYwblFd7H3zdv9IcxQaPSzjJTpb4l4uR5emF-BIRHLSVPyMeK9klH6MnWj90KPgn8rlEeEAYTSQXjloCELKa8Artu9i730Fd9YPDXCFrfXHSrpUfenSP1YRjCBHksWvGnHsvitgm_VjI1a2k0XIxRF0wiW0qxbWgcL0J89PvEAxI7c8mAGozaxp2jYzVsn6Tq1wNE4Uhk3_7XaaRv3HRv1CTvFAB4C0vFIs2zp7YirWOUVDJL5FqB3GES-ychxQ_Yacc0ofLso9rCvjxE6G3eXuzgcUEwxoZ9lP3r6h4UreFB8awJbzd_S6Vmcg5uEpRFBtKAiGdMDWaLpaqOrHYky_YinmgvCLoL9tAr6Wui5YEb4IA_dKrT8_rqcwVixHAtjgRiomDFyUZQf_7RHur2i26p8IRhh0iOp3pibCS77jVrwamNOiYT0pIxE01hRMumC69tdu3eoir9kIbT3Z_ejKNP49_kYQNURN884GeLf5ko3GknF55fF3XNfDz1oJSUgWvvGPDar3i7u1FdOMnUKF0zJHBb0k8BuvVCfLPmtTiv7PAlHzX8-K4DULNmwHONMBXVya7rd89X4Qxp3Jlg3byUFwy4_QzkuUL5ZUycLSkgJ_1AxGJ4LO9fz3fJ2Tm7SX8SGGJ-EcHqeJQAn_K631B1Gq-zbUIOQGe2nmyI67ceblL4h0_lVBDmR9g9V4DYCi7kUpFay3DwSHTUkpXPSDCYvbq33wqWiaupJj0ema9w3uEFVbQJlq_EPRVdPaKeqxTOh4EhRtKHl42YiMWoUMKxx0Og5O22shTP2OSxJhFAOYaiFihUp_73pCp4-x9JHLDpFnuTv1uIgsoh9GcgGRrEhKT6tUhuQCXjEPo8ED2nAbxEtJVyAVAP-GOg1oqQODC47GwTPf9zNeFWR4S3gWT_H_PlNy9OHHlRYE1-D3saOILLdh_jTTZ7cac40NKhPovrfn9mMtC-zuYIHiih0OsUbSJexTlqJUa7HjwCgyq9YLvTXXdIT4CTvjP_KUV1tWFL8AnwugrqeYnSvGst5nW4QuG0ECEmjs0IdSw_qYcxnzJQFLbi0Ji25oYpt_RQsuRzdWSL6W7b-qyLe-SPbj-70kyCKF-Ubt0kLx"},"hashes":{"sha256":"nmCl8VgvYfheY_dSzW89PgjHsXzcxEhik_PuHAl_Wtc"},"signatures":{"@gz3Kb2QKGA29cL72NzTni3OosF9dYQmNPkYtea21eIQ":{"wots-sha256-160-8-mt6:TEST51":"AAAAAHTBS1lt4H61CtIOaQNlkkru3L2nW6RREWbXA74oIsS4zAmCY2CZcwww1nnYnl8BECYkRH659OCdvgdB_nYsxggKqJpIlcDrursVMesXpjAicJnn2p43UhNZ5v0r0IRMNSj-71GZvqKOcI1qpbeLqB134GNKLO29rbQkjV26uClKwLqDGmGuTANlqSpD4L0tjRrYWoVT3WXuGknUANg0ba34vF0PYpz6tJxzJK2Opi9BjQnYV5t_VIuRxi7l3_h8LbnZO5yC9Q_OOSUAlGWhMR9QhMMndEsGwKCL2RagNwS4gxMnP6ZOvrAZJavpACdHzQF4zTl4Q2wDOoTasaoicPYqzua79Rt1Hd4veIPp-cn6B5BhWliatP6Ys5ZYGwq7DyAiahl0xTCayq4lcmiL1p5CvU8DM8LEepMX1jX4zFCSV5agUjWJHRTd7NcJNzs1RHbwmewg2wujIxD-7f8574PnHPq6rsUAsz28TfUdzz2XJUNTGD6PNwErppMgj47a9NH4_rIzGKYZW8GRC50cai6MYJvnF-bfzXSwfKPvwdYG-OVJ2keZksX7_a0exYQ_XK7S-m3saoAxENZPBFjZVZulbvMeo7ozU9lhdK2jXKG9OX2iwz8YQAP24-4gTQiehNpvlRoCvf4VgbixjOJ1GRk0HrqINqvdYddZ1Y6HOShsbJ6fSR4y0Vqex-mCARddFEZH2kFjAIBRix-y2mmCAFoK3F-LNCeIX2SVArhwqEAOmssLtYwFV3gcBQ85wkfsuZwTRUcCq-zQixje0Cip_1ef7Pp0tLN5j8_8eApiQAl0i7Vx5eL2jR5BpAKmEm8eEIh20Fcp3QH6EW3xObzX72x5BPUgKq4NZ1Sla_KRus4LL4g6KPR7MXKrAzEbeSUcnqu5Qa5h39hLMfZ2OpUSlIHCobuVlVxOlvERmuh6ZEivFLDxckLmIeHo3t7EwA8ZUypG0jEjbIeLv9xAUdnvpf7XU1kJDuNAXcQY23XnjV5RIUmqLh-KMRuObLImqcpp03RVxD4G5FNL-vOE7WZtnMhTh-d385CI6hfBGPcd0EMTaupEfH_MMxOxlcUgWUCseA9lRBz-5Ah3fS2yUpd2Y463r27UgLwNl1uaregeSrWxliRjg3fdMiXAOpI6ItRY7oziR1LSEyTAc9qZsqKWSmgrPfp4poN5kKWEXfHQ8oWGOPSv2geYDkpdPjC_KkApyOcCFexjhc3XsIFSBz8l--dhqT5ipstmSS8uhjDychII"},"~CM1u95QHafQfFW6nrQ0T--AP1ovvab7NTTniwta_dE4":{"wots-sha256-160-8-mt6:1":"AAAAADBnQYws3cYWLaTav1Xv2jpFp9iZrYR72sHLSac8_jwY7-MnMnMmtVdVlwkEUyOVJ8BU5ba56sBzcOqjpGY4Lf6Ya5CI7pURk9NeUooC8_FFddqoJGV7JySXELlff1hgqC_vx0htxRtWdG_lZHu-ixk5n4XUqRRJMRrjWswFIcKmeRkXvSbZwuLgOw_0rEPhQ5nhWkdQA4AYaPoRRi1HTabdCZL0oVXA1k1sxnMk_jZm0MwjCh7Kk13JWLQ-yI04-06t1PSZtm1fkKZxNsM6GQqA8_EADWxAy6WT43eJopGpxmzIDFXGeXAp0QoFbv7uTkv7MEyv4Ww72-XVMwcNZen98l-7PFLsJWrMW2hAL3SEPPyCBkNtGh9IbfyBKinvMbhddX5Y0U8aqwIyy6MqZOvyd9FHR4Jur71KQV_BJmkp9kVhyyb8jZd1oHeFiZT2koiblJCP5Pr2589rapjzfFfUPSbYTxNN7jvYcPSYA2pdJNlHy9-r1M2MdHK4xtKQwZQW3brr4s-onp2gE8hV7ADBTYkIOWVwCmebJImVxnzgd5stDK734IE64_ETKVUDehzlS25ezbWUYWtBqpiLhGN787Q6Slxdzl34PqnhlOEx4PEln3h8Oq4cp0EPLpEZk2IhQAD-6A56fVbKQ0ixDPWrySujE-9oHTXczczl7AXx0XAPqPjHi_-PUPeXXRdC6uWDQm9BAzd8vPlE4N-kfNfYy7tujf93OoFXSE17gN6WHNgpJk64jv6Vg8O_0n2U9lPmzWhAEqOVF1syHTHGENDoqAez_m8XVrG2suC5-ULzxyJxzqanYZuSy35TN0zgWyHwhDNNT5FCHGJaJjMAdPKS_HeRbWe_wVR0jodvgqkcEMfA_Ipk0LX9it51ZR3dgjT3yPNktOq5xgr-JQZtP6gcWCPuV5gHl2-yHgdhnRhDgNN3z5NoG9GSUM5oG95beWFpPVvS1o12xoW4sU3dZyzETufAcLnLO77Ygl8ywqanaWeriHTsEYUzgGcTEGb8Jijj-Wx3taPhGkkvTC4x6ROG_hxECk_0nfstVUCpTYZEFc61LakLdOsXtgsFnbQ27ZqFY0bXga2iY7b2916bMPvIFyAF3oMTrine3kDHD9rKZJUsymDk4Sy1-JdCP4Ust3ApthjPizw20gtQoXtdyb28pFI-zUrJsVmO5SW8EfprEKZTfMZfzRa5QvZPH4zAFIvqcqlBj9bivpkL1ug9hxlYPApcOHYTFZ-os6NRiR7j"}}};
const CREATE_EVENT_ID = "$53tnrM_aNeNA39k1jTFAlx_OwWdq2t5MtZEoKERB4WE";

async function wasmBinary() {
    // Node has no `fetch` for file: URLs, so read the binary directly there.
    const {readFile} = await import("node:fs/promises");
    return readFile(new URL("./wasm/cygnus_wasm_bg.wasm", import.meta.url));
}

async function loadedVerifier() {
    const verifier = new CygnusVerifier();
    await verifier.load(await wasmBinary());
    return verifier;
}

export function tests() {
    return {
        "unloaded verifier reports an error instead of throwing": assert => {
            const result = new CygnusVerifier().verifyChain([A0]);
            assert.equal(result.ok, false);
        },
        "verifies a server link chain": async assert => {
            const verifier = await loadedVerifier();
            const result = verifier.verifyChain([A0, A1]);
            assert.equal(result.ok, true);
            assert(result.principal.startsWith("~"));
        },
        "rejects a chain without its genesis": async assert => {
            const verifier = await loadedVerifier();
            assert.equal(verifier.verifyChain([A1]).ok, false);
        },
        "computes the event ID of the create event": async assert => {
            const verifier = await loadedVerifier();
            assert.equal(verifier.eventId(CREATE_PDU).eventId, CREATE_EVENT_ID);
            const reordered = {signatures: CREATE_PDU.signatures, hashes: CREATE_PDU.hashes, state_key: CREATE_PDU.state_key, auth_events: CREATE_PDU.auth_events, prev_events: CREATE_PDU.prev_events, depth: CREATE_PDU.depth, origin_server_ts: CREATE_PDU.origin_server_ts, content: CREATE_PDU.content, sender: CREATE_PDU.sender, type: CREATE_PDU.type, device_certificate: CREATE_PDU.device_certificate};
            assert.equal(verifier.eventId(reordered).eventId, CREATE_EVENT_ID);
            assert.equal(verifier.verifyEventId(CREATE_PDU, CREATE_EVENT_ID).ok, true);
        },
        "verifies a device signature and rejects a wrong certified key": async assert => {
            const verifier = await loadedVerifier();
            const cert = CREATE_PDU.device_certificate;
            assert.equal(verifier.verifyDeviceSignature(CREATE_PDU, CREATE_PDU.sender, cert.device_id, cert.device_key).ok, true);
            assert.equal(verifier.verifyDeviceSignature(CREATE_PDU, CREATE_PDU.sender, cert.device_id, A0.slice(1, 44)).ok, false);
        },
        "verifies a custodian signature at a height": async assert => {
            const verifier = await loadedVerifier();
            const server = "~CM1u95QHafQfFW6nrQ0T--AP1ovvab7NTTniwta_dE4";
            const key = "rXmHG2KC4uK-36ALb2iEBWyICLlMgZH5YHjXb-KP7TI";
            assert.equal(verifier.verifyCustodianSignature(CREATE_PDU, server, 1, key).ok, true);
            assert.equal(verifier.verifyCustodianSignature(CREATE_PDU, server, 0, key).ok, false);
            assert.equal(verifier.verifyCustodianSignature(CREATE_PDU, server, 1, A0.slice(1, 44)).ok, false);
        },
        "flags an event whose content does not match its ID": async assert => {
            const verifier = await loadedVerifier();
            const tampered = {...CREATE_PDU, origin_server_ts: CREATE_PDU.origin_server_ts + 1};
            assert.equal(verifier.verifyEventId(tampered, CREATE_EVENT_ID).ok, false);
        },
        "rejects padded principals": async assert => {
            const verifier = await loadedVerifier();
            const good = verifier.verifyChain([A0]).principal;
            assert.equal(verifier.parsePrincipal(good).ok, true);
            assert.equal(verifier.parsePrincipal(good + "=").ok, false);
        },
        "recognises principals but not Matrix IDs": assert => {
            assert(isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo"));
            assert(isPrincipal("~CM1u95QHafQfFW6nrQ0T--AP1ovvab7NTTniwta_dE4"));
            assert(!isPrincipal("@alice:example.org"));
            assert(!isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo="));
            assert(!isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQup"));
            assert(!isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo\n"));
        },
        "recognises the Cygnus room version": assert => {
            assert(isCygnusRoomVersion("tk.nutra.cygnus.1"));
            assert(!isCygnusRoomVersion("12"));
        },
    };
}
