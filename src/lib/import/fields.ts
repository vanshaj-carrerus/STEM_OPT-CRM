/**
 * Importable roster columns. `key` is a field of `candidateCreateSchema` (or one of the virtual first/last name
 * parts, which are merged into `legalName`). Aliases are matched against normalised header text.
 */
export type FieldKind = "text" | "date" | "enum";

export interface ImportField {
  key: string;
  label: string;
  kind: FieldKind;
  aliases: string[];
  /** Protected identifier: encrypted in the candidate record and masked in previews. */
  sensitive?: boolean;
  /** Needs `immigration.edit` (createCandidate silently drops these otherwise — the preview warns instead). */
  immigration?: boolean;
  /** Part of the downloadable template. */
  template?: boolean;
}

export const IMPORT_FIELDS: ImportField[] = [
  { key: "legalName", label: "Legal Name", kind: "text", template: true, aliases: ["name", "fullname", "candidatename", "studentname", "employeename", "candidate", "legalfullname"] },
  { key: "firstName", label: "First Name", kind: "text", aliases: ["first", "fname", "givenname", "firstgivenname"] },
  { key: "lastName", label: "Last Name", kind: "text", aliases: ["last", "lname", "surname", "familyname", "lastsurname"] },
  { key: "preferredName", label: "Preferred Name", kind: "text", template: true, aliases: ["nickname", "preferred"] },
  { key: "email", label: "Email", kind: "text", template: true, aliases: ["emailaddress", "emailid", "mail", "candidateemail", "personalemail", "studentemail", "primaryemail"] },
  { key: "phone", label: "Phone", kind: "text", template: true, aliases: ["phonenumber", "mobile", "mobilenumber", "cell", "cellphone", "contactnumber", "telephone"] },
  { key: "dateOfBirth", label: "Date of Birth", kind: "date", sensitive: true, template: true, aliases: ["dob", "birthdate", "birthday"] },
  { key: "addressLine1", label: "Address Line 1", kind: "text", template: true, aliases: ["address", "address1", "street", "streetaddress"] },
  { key: "addressLine2", label: "Address Line 2", kind: "text", aliases: ["address2", "apt", "unit", "suite"] },
  { key: "city", label: "City", kind: "text", template: true, aliases: ["town"] },
  { key: "state", label: "State", kind: "text", template: true, aliases: ["province", "region"] },
  { key: "postalCode", label: "Postal Code", kind: "text", template: true, aliases: ["zip", "zipcode", "postcode", "zippostal"] },
  { key: "addressCountry", label: "Address Country", kind: "text", aliases: [] },
  { key: "country", label: "Country", kind: "text", template: true, aliases: ["citizenship", "nationality", "countryofcitizenship", "countryoforigin"] },
  { key: "school", label: "School", kind: "text", template: true, aliases: ["university", "college", "institution", "schoolname", "universityname"] },
  { key: "campus", label: "Campus", kind: "text", aliases: [] },
  { key: "degreeLevel", label: "Degree Level", kind: "text", template: true, aliases: ["level", "educationlevel"] },
  { key: "degree", label: "Degree", kind: "text", template: true, aliases: ["degreename"] },
  { key: "major", label: "Major", kind: "text", template: true, aliases: ["fieldofstudy", "program", "areaofstudy"] },
  { key: "stemCipCode", label: "STEM CIP Code", kind: "text", aliases: ["cip", "cipcode", "majorcip", "cipcodemajor"] },
  { key: "programStart", label: "Program Start", kind: "date", aliases: ["programstartdate", "programbegin"] },
  { key: "programEnd", label: "Program End", kind: "date", aliases: ["programenddate"] },
  { key: "graduationDate", label: "Graduation Date", kind: "date", template: true, aliases: ["graduation", "graddate", "expectedgraduation", "expectedgraduationdate", "completiondate"] },
  { key: "dsoName", label: "DSO Name", kind: "text", aliases: ["dso", "dsocontact"] },
  { key: "dsoEmail", label: "DSO Email", kind: "text", aliases: ["dsoemailaddress"] },
  { key: "dsoPhone", label: "DSO Phone", kind: "text", aliases: ["dsophonenumber"] },
  { key: "sevisId", label: "SEVIS ID", kind: "text", sensitive: true, immigration: true, template: true, aliases: ["sevis", "sevisnumber", "sevisno", "sid"] },
  { key: "visaStatus", label: "Visa Status", kind: "text", immigration: true, template: true, aliases: ["visa", "immigrationstatus", "visatype"] },
  { key: "authType", label: "Authorization Type", kind: "enum", immigration: true, template: true, aliases: ["authtype", "authorization", "workauthorization", "workauth", "cptopt", "optcpt", "worktype"] },
  { key: "eadCategory", label: "EAD Category", kind: "text", immigration: true, aliases: ["category", "eadcat"] },
  { key: "eadNumber", label: "EAD Number", kind: "text", sensitive: true, immigration: true, aliases: ["eadno", "ead", "eadcardnumber", "eadcard"] },
  { key: "eadStart", label: "EAD Start", kind: "date", immigration: true, template: true, aliases: ["eadstartdate", "optstart", "optstartdate", "stemstart", "stemstartdate", "authorizationstart"] },
  { key: "eadEnd", label: "EAD End", kind: "date", immigration: true, template: true, aliases: ["eadenddate", "optend", "optenddate", "stemend", "stemenddate", "eadexpiry", "eadexpiration", "eadexpirationdate", "authorizationend"] },
  { key: "i20IssueDate", label: "I-20 Issue Date", kind: "date", immigration: true, aliases: ["i20date", "i20issued", "i20issue"] },
  { key: "i20EndorsementDate", label: "I-20 Endorsement Date", kind: "date", immigration: true, aliases: ["i20endorsed", "i20endorsement", "cptendorsementdate"] },
  { key: "receiptNumber", label: "Receipt Number", kind: "text", immigration: true, aliases: ["receipt", "i797receipt", "i797", "receiptno"] },
  { key: "caseStatus", label: "Case Status", kind: "text", immigration: true, aliases: [] },
  { key: "stage", label: "Stage", kind: "enum", aliases: ["candidatestage", "candidatestatus", "pipelinestage"] },
  { key: "priority", label: "Priority", kind: "enum", aliases: [] },
  { key: "source", label: "Source", kind: "text", template: true, aliases: ["leadsource", "referral", "referredby"] },
  { key: "tagsCsv", label: "Tags", kind: "text", aliases: ["tag", "labels"] },
];

export const FIELD_BY_KEY: Record<string, ImportField> = Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, f]));

/** Lower-case alphanumerics only, so "E-mail Address", "e_mail address" and "EMAILADDRESS" compare equal. */
export function normalizeHeader(h: string): string {
  return h
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const ALIAS_INDEX: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const f of IMPORT_FIELDS) {
    for (const a of [normalizeHeader(f.key), normalizeHeader(f.label), ...f.aliases]) if (!m.has(a)) m.set(a, f.key);
  }
  return m;
})();

/**
 * Auto-guess the target field for each header (same order as `headers`). A field is assigned to at most one column
 * (first match wins); unrecognised columns map to null and are shown as "unmapped" so the user can decide.
 */
export function guessMapping(headers: readonly string[]): (string | null)[] {
  const used = new Set<string>();
  return headers.map((h) => {
    const key = ALIAS_INDEX.get(normalizeHeader(h));
    if (!key || used.has(key)) return null;
    used.add(key);
    return key;
  });
}

/** True when the mapping can produce a legal name and an email (the two fields every candidate needs). */
export function missingRequiredFields(mapping: readonly (string | null)[]): string[] {
  const has = new Set(mapping.filter(Boolean) as string[]);
  const out: string[] = [];
  if (!has.has("legalName") && !(has.has("firstName") && has.has("lastName"))) out.push("Legal Name (or First Name + Last Name)");
  if (!has.has("email")) out.push("Email");
  return out;
}

/** Keeps each target field mapped at most once (later duplicates are dropped to null) and rejects unknown keys. */
export function sanitizeMapping(mapping: readonly (string | null)[], headerCount: number): (string | null)[] {
  const used = new Set<string>();
  return Array.from({ length: headerCount }, (_, i) => {
    const k = mapping[i];
    if (!k || !FIELD_BY_KEY[k] || used.has(k)) return null;
    used.add(k);
    return k;
  });
}

/** Header row for the downloadable CSV template (headers only — never sample people). */
export const TEMPLATE_HEADERS = IMPORT_FIELDS.filter((f) => f.template).map((f) => f.label);
