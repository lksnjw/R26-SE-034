import type { FastifyReply, FastifyRequest } from "fastify";
import { approvalTierSchema, companyProfileSchema, costCentreSchema, departmentSchema } from "../../models/boundary.js";
import { ok } from "../../models/schemas.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, requestParam, stringValue } from "./common.js";

export const COMPANY_UNHANDLED = Symbol("company-unhandled");
type CompanyCollection = "departments" | "costCentres" | "approvalTiers";
const defaultCompany = { name: "", legalName: "", industry: "", timezone: "UTC", currency: "USD", fiscalYearStart: "", contactEmail: "", erpSystemName: "", erpVersion: "", notes: "", departments: [], costCentres: [], approvalTiers: [] };

/** Owns company-profile and company-reference-data HTTP behavior. */
export async function handleCompanyRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown | typeof COMPANY_UNHANDLED> {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/company` && route.method === "GET") return getCompany(reply, user, services);
  if (route.path === `${base}/company` && route.method === "PUT") return updateCompany(request, reply, user, services);
  const collections: Array<{ path: string; key: CompanyCollection }> = [
    { path: "departments", key: "departments" },
    { path: "cost-centres", key: "costCentres" },
    { path: "approval-tiers", key: "approvalTiers" },
  ];
  for (const collection of collections) {
    if (route.path === `${base}/company/${collection.path}` && route.method === "GET") return listCompanyCollection(reply, user, services, collection.key);
    if (route.path === `${base}/company/${collection.path}` && route.method === "POST") return createCompanyItem(request, reply, user, services, collection.key);
    if (route.path === `${base}/company/${collection.path}/:id` && route.method === "PUT") return updateCompanyItem(request, reply, user, services, collection.key);
    if (route.path === `${base}/company/${collection.path}/:id` && route.method === "DELETE") return deleteCompanyItem(request, reply, user, services, collection.key);
  }
  return COMPANY_UNHANDLED;
}

function isCompanyAdmin(user: CurrentUser): boolean { return user.role === "Platform Admin" || user.role === "System Admin"; }
function requireCompanyWrite(user: CurrentUser): void { if (!isCompanyAdmin(user)) throw new HandlerFailure(403, "Only Platform Admin and System Admin roles can edit the company profile"); }
function requireCompanyRead(user: CurrentUser): void { if (!isCompanyAdmin(user)) throw new HandlerFailure(403, "Only Platform Admin and System Admin roles can read this company data"); }
async function company(services: HandlerServices): Promise<Record<string, unknown>> { return services.repository.read((state) => state.company === null ? structuredClone(defaultCompany) : structuredClone(state.company)); }
async function getCompany(reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { const profile = await company(services); if (isCompanyAdmin(user)) return reply.send(ok(profile, "Company profile loaded", null)); const departments = Array.isArray(profile.departments) ? profile.departments.map((item) => isRecord(item) ? { id: item.id, name: item.name } : item) : []; return reply.send(ok({ name: profile.name, legalName: profile.legalName, industry: profile.industry, timezone: profile.timezone, currency: profile.currency, fiscalYearStart: profile.fiscalYearStart, departments }, "Company profile loaded", null)); }
async function updateCompany(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  requireCompanyWrite(user); const parsed = companyProfileSchema.safeParse(request.body ?? {}); if (!parsed.success) throw companyValidation(parsed.error.issues);
  const issues: { path: PropertyKey[]; message: string }[] = [];
  if (parsed.data.currency.length !== 3) issues.push({ path: ["currency"], message: `currency "${parsed.data.currency}" must be a 3-letter code` });
  if (parsed.data.timezone.trim() === "") issues.push({ path: ["timezone"], message: "timezone is required" });
  if (issues.length > 0) throw companyValidation(issues);
  const profile = normalizeCompany(parsed.data as unknown as Record<string, unknown>);
  await services.repository.mutate((state) => { const before = state.company; state.company = profile; appendAudit(state, user, "company.updated", "company", "default", before, profile, request); });
  return reply.send(ok(profile, "Company profile updated", null));
}
async function listCompanyCollection(reply: FastifyReply, user: CurrentUser, services: HandlerServices, collection: CompanyCollection): Promise<unknown> { if (collection !== "departments") requireCompanyRead(user); const profile = await company(services); const values = Array.isArray(profile[collection]) ? profile[collection] as unknown[] : []; const visible = collection === "departments" && !isCompanyAdmin(user) ? values.map((item) => isRecord(item) ? { id: item.id, name: item.name } : item) : values; const title = collection === "departments" ? "Company departments loaded" : collection === "costCentres" ? "Company cost centres loaded" : "Company approval tiers loaded"; return reply.send(ok(visible, title, { count: visible.length })); }
async function createCompanyItem(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices, collection: CompanyCollection): Promise<unknown> { requireCompanyWrite(user); const input = parseCompanyItem(collection, request.body); const created = await services.repository.mutate((state) => { const profile = state.company === null ? structuredClone(defaultCompany) : state.company; const list = Array.isArray(profile[collection]) ? profile[collection] as Record<string, unknown>[] : []; const identity = itemIdentity(collection, input); if (collection === "departments" && identity === "") input.id = nextID(state, "dept"); const actualID = itemIdentity(collection, input); if (list.some((item) => itemIdentity(collection, item).toLowerCase() === actualID.toLowerCase())) throw new HandlerFailure(409, `${companyItemName(collection)} already exists`); list.push(input); profile[collection] = list; state.company = profile; appendAudit(state, user, `company.${companyActionName(collection)}.created`, companyActionName(collection), actualID, null, input, request); return structuredClone(input); }); return reply.status(201).send(ok(created, `Company ${companyItemLabel(collection)} created`, null)); }
async function updateCompanyItem(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices, collection: CompanyCollection): Promise<unknown> {
  requireCompanyWrite(user); const id = requestParam(request, "id");
  const exists = await services.repository.read((state) => { const profile = state.company === null ? defaultCompany : state.company; const list = Array.isArray(profile[collection]) ? profile[collection] as Record<string, unknown>[] : []; return list.some((item) => itemIdentity(collection, item).toLowerCase() === id.toLowerCase()); });
  if (!exists) throw new HandlerFailure(404, `${companyItemName(collection)} not found`);
  const input = parseCompanyItem(collection, request.body); if (collection === "departments") input.id = id; if (collection === "costCentres") input.code = id;
  const updated = await services.repository.mutate((state) => { const profile = state.company === null ? structuredClone(defaultCompany) : state.company; const list = Array.isArray(profile[collection]) ? profile[collection] as Record<string, unknown>[] : []; const index = list.findIndex((item) => itemIdentity(collection, item).toLowerCase() === id.toLowerCase()); if (index < 0) throw new HandlerFailure(404, `${companyItemName(collection)} not found`); const before = list[index]!; list[index] = input; profile[collection] = list; state.company = profile; appendAudit(state, user, `company.${companyActionName(collection)}.updated`, companyActionName(collection), id, before, input, request); return structuredClone(input); });
  return reply.send(ok(updated, `Company ${companyItemLabel(collection)} updated`, null));
}
async function deleteCompanyItem(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices, collection: CompanyCollection): Promise<unknown> { requireCompanyWrite(user); const id = requestParam(request, "id"); await services.repository.mutate((state) => { const profile = state.company === null ? structuredClone(defaultCompany) : state.company; const list = Array.isArray(profile[collection]) ? profile[collection] as Record<string, unknown>[] : []; const index = list.findIndex((item) => itemIdentity(collection, item).toLowerCase() === id.toLowerCase()); if (index < 0) throw new HandlerFailure(404, `${companyItemName(collection)} not found`); if (collection === "departments") { const users = Object.values(state.users).filter((item) => item.departmentId === id).length; if (users > 0) throw new HandlerFailure(409, `Department is assigned to ${users} user(s)`, { users }); } const before = list[index]!; list.splice(index, 1); profile[collection] = list; state.company = profile; appendAudit(state, user, `company.${companyActionName(collection)}.deleted`, companyActionName(collection), id, before, null, request); }); return reply.send(ok({ deleted: true }, `Company ${companyItemLabel(collection)} deleted`, null)); }
function parseCompanyItem(collection: CompanyCollection, input: unknown): Record<string, unknown> { const schema = collection === "departments" ? departmentSchema : collection === "costCentres" ? costCentreSchema : approvalTierSchema; const parsed = schema.safeParse(input ?? {}); if (!parsed.success) throw companyValidation(parsed.error.issues); const value = parsed.data as unknown as Record<string, unknown>; const issues: { path: PropertyKey[]; message: string }[] = []; if (collection === "costCentres") { if (stringValue(value.code).trim() === "") issues.push({ path: ["costCentres", 0, "code"], message: "cost centre code is required" }); if (stringValue(value.currency).length !== 3) issues.push({ path: ["costCentres", 0, "currency"], message: `currency "${stringValue(value.currency)}" must be a 3-letter code` }); } if (collection === "approvalTiers" && stringValue(value.label).trim() === "") issues.push({ path: ["approvalTiers", 0, "label"], message: "approval tier label is required" }); if (issues.length > 0) throw companyValidation(issues); return value; }
function companyValidation(issues: { path: PropertyKey[]; message: string }[]): HandlerFailure { return new HandlerFailure(422, "Company profile validation failed", { fieldErrors: Object.fromEntries(issues.map((issue) => [issue.path.join("."), issue.message])) }); }
function itemIdentity(collection: CompanyCollection, item: Record<string, unknown>): string { return stringValue(item[collection === "departments" ? "id" : collection === "costCentres" ? "code" : "label"]); }
function companyItemName(collection: CompanyCollection): string { return collection === "departments" ? "Department" : collection === "costCentres" ? "Cost centre" : "Approval tier"; }
function companyItemLabel(collection: CompanyCollection): string { return collection === "departments" ? "department" : collection === "costCentres" ? "cost centre" : "approval tier"; }
function companyActionName(collection: CompanyCollection): string { return collection === "departments" ? "department" : collection === "costCentres" ? "cost_centre" : "approval_tier"; }
function normalizeCompany(profile: Record<string, unknown>): Record<string, unknown> { return { ...profile, timezone: stringValue(profile.timezone).trim() === "" ? "UTC" : profile.timezone, currency: stringValue(profile.currency).trim() === "" ? "USD" : profile.currency, departments: Array.isArray(profile.departments) ? profile.departments : [], costCentres: Array.isArray(profile.costCentres) ? profile.costCentres : [], approvalTiers: Array.isArray(profile.approvalTiers) ? profile.approvalTiers : [] }; }
