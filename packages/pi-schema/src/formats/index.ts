// The format checks of JSON Schema 2020-12, for compile()'s `formats` option. An optional entry point: schemas
// compiled without it treat `format` as an annotation and do not bundle these checks.

import type { FormatCheck } from "../types.js";
import { IsDate } from "./typebox/date.js";
import { IsDateTime } from "./typebox/date_time.js";
import { IsDuration } from "./typebox/duration.js";
import { IsEmail } from "./typebox/email.js";
import { IsHostname } from "./typebox/hostname.js";
import { IsIdnEmail } from "./typebox/idn_email.js";
import { IsIdnHostname } from "./typebox/idn_hostname.js";
import { IsIPv4 } from "./typebox/ipv4.js";
import { IsIPv6 } from "./typebox/ipv6.js";
import { IsIri } from "./typebox/iri.js";
import { IsIriReference } from "./typebox/iri_reference.js";
import { IsJsonPointer } from "./typebox/json_pointer.js";
import { IsJsonPointerUriFragment } from "./typebox/json_pointer_uri_fragment.js";
import { IsRegex } from "./typebox/regex.js";
import { IsRelativeJsonPointer } from "./typebox/relative_json_pointer.js";
import { IsTime } from "./typebox/time.js";
import { IsUri } from "./typebox/uri.js";
import { IsUriReference } from "./typebox/uri_reference.js";
import { IsUriTemplate } from "./typebox/uri_template.js";
import { IsUrl } from "./typebox/url.js";
import { IsUuid } from "./typebox/uuid.js";

/**
 * Every format JSON Schema 2020-12 defines, by name, plus `url` and `json-pointer-uri-fragment`, which TypeBox and
 * ajv-formats also check. The checks are adapted from TypeBox 1.3.27 (MIT).
 */
export const formats: Readonly<Record<string, FormatCheck>> = Object.freeze({
	date: IsDate,
	"date-time": IsDateTime,
	duration: IsDuration,
	email: IsEmail,
	hostname: IsHostname,
	"idn-email": IsIdnEmail,
	"idn-hostname": IsIdnHostname,
	ipv4: IsIPv4,
	ipv6: IsIPv6,
	iri: IsIri,
	"iri-reference": IsIriReference,
	"json-pointer": IsJsonPointer,
	"json-pointer-uri-fragment": IsJsonPointerUriFragment,
	regex: IsRegex,
	"relative-json-pointer": IsRelativeJsonPointer,
	time: IsTime,
	uri: IsUri,
	"uri-reference": IsUriReference,
	"uri-template": IsUriTemplate,
	url: IsUrl,
	uuid: IsUuid,
});
