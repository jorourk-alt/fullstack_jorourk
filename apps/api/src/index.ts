import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import { z } from "zod";

dotenv.config();

type UserRole = "admin" | "member" | "teacher";

type AuthResponse = {
  error?: string;
  message?: string;
};

type AuthenticatedUser = {
  id: string;
  role: UserRole;
};

const port = Number(process.env.PORT ?? 4000);
const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const corsOriginsRaw =
  process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN ?? "http://localhost:5173";
const allowedOrigins = corsOriginsRaw
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

if (!supabaseUrl || !supabasePublishableKey || !supabaseServiceRoleKey) {
  throw new Error(
    "Missing Supabase configuration. Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SERVICE_ROLE_KEY."
  );
}

const authClient = createClient(supabaseUrl, supabasePublishableKey);
const dbClient = createClient(supabaseUrl, supabaseServiceRoleKey);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  })
);
app.use(express.json());

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100)
});

const createClassSchema = z.object({
  title: z.string().min(2).max(120),
  description: z.string().min(2).max(2000),
  instructorName: z.string().min(2).max(120),
  location: z.string().min(2).max(120),
  startsAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "startsAt must be an ISO 8601 date-time string"
  }),
  capacity: z.number().int().min(1).max(1000),
  teacherId: z.string().uuid().nullable().optional()
});

const updateClassSchema = z.object({
  title: z.string().min(2).max(120).optional(),
  description: z.string().min(2).max(2000).optional(),
  instructorName: z.string().min(2).max(120).optional(),
  location: z.string().min(2).max(120).optional(),
  startsAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "startsAt must be an ISO 8601 date-time string"
    })
    .optional(),
  capacity: z.number().int().min(1).max(1000).optional()
});

const registerSchema = z.object({
  classId: z.string().uuid()
});

const adminEnrollSchema = z.object({
  memberId: z.string().uuid()
});

const attendanceSubmitSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  records: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        status: z.enum(["present", "absent", "late"])
      })
    )
    .min(1)
});

const promoteSchema = z.object({
  role: z.enum(["admin", "member", "teacher"])
});

const classInsertSchema = z.object({
  created_by: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  instructor_name: z.string(),
  location: z.string(),
  starts_at: z.string(),
  capacity: z.number().int(),
  teacher_id: z.string().uuid().nullable().optional()
});

type CommunityClass = {
  id: string;
  title: string;
  description: string;
  instructor_name: string;
  location: string;
  starts_at: string;
  capacity: number;
  created_at: string;
  created_by: string;
  teacher_id: string | null;
};

type UserRecord = {
  id: string;
  role: UserRole;
};

function readBearerToken(request: Request) {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

async function fetchAllAuthUsers() {
  const allUsers: { id: string; email?: string }[] = [];
  let page = 1;
  while (true) {
    const { data, error } = await dbClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data) break;
    allUsers.push(...data.users);
    if (data.users.length < 1000) break;
    page++;
  }
  return allUsers;
}

async function fetchUserRole(userId: string): Promise<UserRole | null> {
  const { data, error } = await dbClient
    .from("users")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data?.role) {
    return null;
  }

  if (data.role !== "admin" && data.role !== "member" && data.role !== "teacher") {
    return null;
  }

  return data.role;
}

async function requireUser(
  request: Request,
  response: Response,
  allowedRoles?: UserRole[]
): Promise<AuthenticatedUser | null> {
  const token = readBearerToken(request);

  if (!token) {
    response.status(401).json({ error: "Missing Bearer token" });
    return null;
  }

  const { data, error } = await authClient.auth.getUser(token);

  if (error || !data.user) {
    response.status(401).json({ error: "Invalid or expired token" });
    return null;
  }

  const role = await fetchUserRole(data.user.id);
  if (!role) {
    response.status(403).json({ error: "No user role found for this account." });
    return null;
  }

  if (allowedRoles && !allowedRoles.includes(role)) {
    response.status(403).json({ error: "Insufficient role permissions." });
    return null;
  }

  return {
    id: data.user.id,
    role
  };
}

async function upsertUserRole(userId: string, role: UserRole) {
  const { error } = await dbClient
    .from("users")
    .upsert({ id: userId, role }, { onConflict: "id" });

  return error;
}

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/auth/signup", async (request, response) => {
  const parsed = signupSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: "Invalid signup payload" });
    return;
  }

  const { data, error } = await authClient.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password
  });

  if (error) {
    response.status(400).json({ error: error.message });
    return;
  }

  if (data.user?.id) {
    const userError = await upsertUserRole(data.user.id, "member");
    if (userError) {
      response.status(500).json({
        error: "Account created but user role could not be saved.",
        details: userError.message
      });
      return;
    }
  }

  response.status(201).json({
    message:
      "Account created. Check your email if confirmation is required by your Supabase auth settings.",
    userId: data.user?.id ?? null,
    accessToken: data.session?.access_token ?? null,
    role: "member" as UserRole
  });
});

app.post("/api/auth/login", async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: "Invalid login payload" });
    return;
  }

  const { data, error } = await authClient.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password
  });

  if (error || !data.session) {
    response.status(401).json({ error: error?.message ?? "Login failed" });
    return;
  }

  const role = await fetchUserRole(data.user.id);

  if (!role) {
    response.status(403).json({ error: "No user role found for this account." });
    return;
  }

  response.json({
    message: "Login successful",
    userId: data.user.id,
    accessToken: data.session.access_token,
    role
  });
});

app.get("/api/auth/me", async (request, response) => {
  const user = await requireUser(request, response);
  if (!user) {
    return;
  }

  response.json({
    userId: user.id,
    role: user.role
  });
});

// Admin: list all users with their roles
app.get("/api/admin/users", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) return;

  const { data, error } = await dbClient
    .from("users")
    .select("id, role")
    .order("role", { ascending: true });

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  const authUsers = await fetchAllAuthUsers();
  const emailMap = new Map(authUsers.map((u) => [u.id, u.email ?? ""]));

  const result = (data ?? []).map((row: UserRecord) => ({
    id: row.id,
    email: emailMap.get(row.id) ?? row.id,
    role: row.role
  }));

  response.json(result);
});

// Admin: promote/demote a user's role
app.post("/api/admin/users/:userId/promote", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) return;

  const { userId } = request.params;

  const parsed = promoteSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Role must be admin, member, or teacher." });
    return;
  }

  const { error } = await dbClient
    .from("users")
    .update({ role: parsed.data.role })
    .eq("id", userId);

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.json({ message: `User role updated to ${parsed.data.role}.` });
});

// Admin: list teachers (for class assignment dropdown)
app.get("/api/admin/teachers", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) return;

  const { data, error } = await dbClient
    .from("users")
    .select("id, role")
    .eq("role", "teacher");

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  const authUsers = await fetchAllAuthUsers();
  const emailMap = new Map(authUsers.map((u) => [u.id, u.email ?? ""]));

  const result = (data ?? []).map((row: UserRecord) => ({
    id: row.id,
    email: emailMap.get(row.id) ?? row.id
  }));

  response.json(result);
});

app.get("/api/admin/classes", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) {
    return;
  }

  const { data, error } = await dbClient
    .from("community_classes")
    .select("id, title, description, instructor_name, location, starts_at, capacity, created_at, created_by, teacher_id")
    .order("starts_at", { ascending: true });

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.json(data ?? []);
});

app.post("/api/admin/classes", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) {
    return;
  }

  const parsed = createClassSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({
      error: "Invalid class payload",
      details: parsed.error.flatten()
    });
    return;
  }

  const classPayload = classInsertSchema.parse({
    created_by: user.id,
    title: parsed.data.title,
    description: parsed.data.description,
    instructor_name: parsed.data.instructorName,
    location: parsed.data.location,
    starts_at: new Date(parsed.data.startsAt).toISOString(),
    capacity: parsed.data.capacity,
    teacher_id: parsed.data.teacherId ?? null
  });

  const { data, error } = await dbClient
    .from("community_classes")
    .insert(classPayload)
    .select("id, title, description, instructor_name, location, starts_at, capacity, created_at, created_by, teacher_id")
    .single();

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.status(201).json(data);
});

// Admin: enroll a member into a class
app.post("/api/admin/classes/:classId/enrollments", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) return;

  const { classId } = request.params;

  const parsed = adminEnrollSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "memberId must be a valid UUID." });
    return;
  }

  const { data: classRecord, error: classError } = await dbClient
    .from("community_classes")
    .select("id, capacity")
    .eq("id", classId)
    .maybeSingle();

  if (classError) {
    response.status(500).json({ error: classError.message });
    return;
  }
  if (!classRecord) {
    response.status(404).json({ error: "Class not found." });
    return;
  }

  const { count, error: countError } = await dbClient
    .from("class_registrations")
    .select("id", { count: "exact", head: true })
    .eq("class_id", classId);

  if (countError) {
    response.status(500).json({ error: countError.message });
    return;
  }
  if ((count ?? 0) >= classRecord.capacity) {
    response.status(409).json({ error: "This class is full." });
    return;
  }

  const { error: insertError } = await dbClient
    .from("class_registrations")
    .insert({ class_id: classId, member_id: parsed.data.memberId });

  if (insertError) {
    if (insertError.code === "23505") {
      response.status(409).json({ error: "Student is already enrolled in this class." });
      return;
    }
    response.status(500).json({ error: insertError.message });
    return;
  }

  response.status(201).json({ message: "Student enrolled." });
});

app.get("/api/member/classes", async (request, response) => {
  const user = await requireUser(request, response, ["member"]);
  if (!user) {
    return;
  }

  const { data: classes, error: classesError } = await dbClient
    .from("community_classes")
    .select("id, title, description, instructor_name, location, starts_at, capacity, created_at, created_by, teacher_id")
    .order("starts_at", { ascending: true });

  if (classesError) {
    response.status(500).json({ error: classesError.message });
    return;
  }

  const { data: registrations, error: registrationsError } = await dbClient
    .from("class_registrations")
    .select("class_id")
    .eq("member_id", user.id);

  if (registrationsError) {
    response.status(500).json({ error: registrationsError.message });
    return;
  }

  const registeredClassIds = new Set((registrations ?? []).map((row) => row.class_id));

  const { data: allRegistrations, error: allRegistrationsError } = await dbClient
    .from("class_registrations")
    .select("class_id");

  if (allRegistrationsError) {
    response.status(500).json({ error: allRegistrationsError.message });
    return;
  }

  const registrationCounts = new Map<string, number>();
  for (const registration of allRegistrations ?? []) {
    const classId = registration.class_id;
    registrationCounts.set(classId, (registrationCounts.get(classId) ?? 0) + 1);
  }

  const responsePayload = (classes ?? []).map((item: CommunityClass) => ({
    ...item,
    registrationCount: registrationCounts.get(item.id) ?? 0,
    isRegistered: registeredClassIds.has(item.id)
  }));

  response.json(responsePayload);
});

app.post("/api/member/registrations", async (request, response) => {
  const user = await requireUser(request, response, ["member"]);
  if (!user) {
    return;
  }

  const parsed = registerSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: "Invalid registration payload" });
    return;
  }

  const { data: classRecord, error: classError } = await dbClient
    .from("community_classes")
    .select("id, capacity")
    .eq("id", parsed.data.classId)
    .maybeSingle();

  if (classError) {
    response.status(500).json({ error: classError.message });
    return;
  }

  if (!classRecord) {
    response.status(404).json({ error: "Class not found" });
    return;
  }

  const { data: existingRegistration, error: existingRegistrationError } = await dbClient
    .from("class_registrations")
    .select("id")
    .eq("class_id", parsed.data.classId)
    .eq("member_id", user.id)
    .maybeSingle();

  if (existingRegistrationError) {
    response.status(500).json({ error: existingRegistrationError.message });
    return;
  }

  if (existingRegistration) {
    response.status(409).json({ error: "You are already registered for this class." });
    return;
  }

  const { count, error: countError } = await dbClient
    .from("class_registrations")
    .select("id", { count: "exact", head: true })
    .eq("class_id", parsed.data.classId);

  if (countError) {
    response.status(500).json({ error: countError.message });
    return;
  }

  if ((count ?? 0) >= classRecord.capacity) {
    response.status(409).json({ error: "This class is full." });
    return;
  }

  const { error: insertError } = await dbClient
    .from("class_registrations")
    .insert({ class_id: parsed.data.classId, member_id: user.id });

  if (insertError) {
    response.status(500).json({ error: insertError.message });
    return;
  }

  response.status(201).json({ message: "Registration successful." } satisfies AuthResponse);
});

// Teacher: get assigned classes
app.get("/api/teacher/classes", async (request, response) => {
  const user = await requireUser(request, response, ["teacher"]);
  if (!user) return;

  const { data, error } = await dbClient
    .from("community_classes")
    .select("id, title, description, instructor_name, location, starts_at, capacity, created_at, created_by, teacher_id")
    .eq("teacher_id", user.id)
    .order("starts_at", { ascending: true });

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.json(data ?? []);
});

// Teacher: edit an assigned class
app.patch("/api/teacher/classes/:classId", async (request, response) => {
  const user = await requireUser(request, response, ["teacher"]);
  if (!user) return;

  const { classId } = request.params;

  // Verify this class is assigned to this teacher
  const { data: classRecord, error: fetchError } = await dbClient
    .from("community_classes")
    .select("id, teacher_id")
    .eq("id", classId)
    .maybeSingle();

  if (fetchError) {
    response.status(500).json({ error: fetchError.message });
    return;
  }

  if (!classRecord) {
    response.status(404).json({ error: "Class not found." });
    return;
  }

  if (classRecord.teacher_id !== user.id) {
    response.status(403).json({ error: "You are not assigned to this class." });
    return;
  }

  const parsed = updateClassSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid update payload", details: parsed.error.flatten() });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.instructorName !== undefined) updates.instructor_name = parsed.data.instructorName;
  if (parsed.data.location !== undefined) updates.location = parsed.data.location;
  if (parsed.data.startsAt !== undefined) updates.starts_at = new Date(parsed.data.startsAt).toISOString();
  if (parsed.data.capacity !== undefined) updates.capacity = parsed.data.capacity;

  if (Object.keys(updates).length === 0) {
    response.status(400).json({ error: "No fields to update." });
    return;
  }

  const { data, error } = await dbClient
    .from("community_classes")
    .update(updates)
    .eq("id", classId)
    .select("id, title, description, instructor_name, location, starts_at, capacity, created_at, created_by, teacher_id")
    .single();

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.json(data);
});

// Teacher: get students enrolled in a class
app.get("/api/teacher/classes/:classId/students", async (request, response) => {
  const user = await requireUser(request, response, ["teacher"]);
  if (!user) return;

  const { classId } = request.params;

  const { data: classRecord, error: fetchError } = await dbClient
    .from("community_classes")
    .select("id, teacher_id")
    .eq("id", classId)
    .maybeSingle();

  if (fetchError) {
    response.status(500).json({ error: fetchError.message });
    return;
  }
  if (!classRecord) {
    response.status(404).json({ error: "Class not found." });
    return;
  }
  if (classRecord.teacher_id !== user.id) {
    response.status(403).json({ error: "You are not assigned to this class." });
    return;
  }

  const { data: registrations, error: regError } = await dbClient
    .from("class_registrations")
    .select("member_id")
    .eq("class_id", classId);

  if (regError) {
    response.status(500).json({ error: regError.message });
    return;
  }

  if (!registrations || registrations.length === 0) {
    response.json([]);
    return;
  }

  const authUsers = await fetchAllAuthUsers();
  const emailMap = new Map(authUsers.map((u) => [u.id, u.email ?? ""]));

  const result = registrations.map((r: { member_id: string }) => ({
    id: r.member_id,
    email: emailMap.get(r.member_id) ?? r.member_id
  }));

  response.json(result);
});

// Teacher: get attendance records for a class, optionally filtered by date
app.get("/api/teacher/classes/:classId/attendance", async (request, response) => {
  const user = await requireUser(request, response, ["teacher"]);
  if (!user) return;

  const { classId } = request.params;
  const date = typeof request.query.date === "string" ? request.query.date : undefined;

  const { data: classRecord, error: fetchError } = await dbClient
    .from("community_classes")
    .select("id, teacher_id")
    .eq("id", classId)
    .maybeSingle();

  if (fetchError) {
    response.status(500).json({ error: fetchError.message });
    return;
  }
  if (!classRecord) {
    response.status(404).json({ error: "Class not found." });
    return;
  }
  if (classRecord.teacher_id !== user.id) {
    response.status(403).json({ error: "You are not assigned to this class." });
    return;
  }

  let query = dbClient
    .from("attendance")
    .select("member_id, session_date, status")
    .eq("class_id", classId);

  if (date) {
    query = query.eq("session_date", date);
  }

  const { data, error } = await query;

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.json(data ?? []);
});

// Teacher: submit (upsert) attendance for a class session
app.post("/api/teacher/classes/:classId/attendance", async (request, response) => {
  const user = await requireUser(request, response, ["teacher"]);
  if (!user) return;

  const { classId } = request.params;

  const { data: classRecord, error: fetchError } = await dbClient
    .from("community_classes")
    .select("id, teacher_id")
    .eq("id", classId)
    .maybeSingle();

  if (fetchError) {
    response.status(500).json({ error: fetchError.message });
    return;
  }
  if (!classRecord) {
    response.status(404).json({ error: "Class not found." });
    return;
  }
  if (classRecord.teacher_id !== user.id) {
    response.status(403).json({ error: "You are not assigned to this class." });
    return;
  }

  const parsed = attendanceSubmitSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid attendance payload", details: parsed.error.flatten() });
    return;
  }

  const rows = parsed.data.records.map((r) => ({
    class_id: classId,
    member_id: r.memberId,
    session_date: parsed.data.date,
    status: r.status,
    marked_by: user.id
  }));

  const { error } = await dbClient
    .from("attendance")
    .upsert(rows, { onConflict: "class_id,member_id,session_date" });

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.json({ message: "Attendance saved." } satisfies AuthResponse);
});

const checkinToggleSchema = z.object({
  memberId: z.string().uuid(),
  checkedIn: z.boolean()
});

// Admin: get students with today's check-in status for a class
app.get("/api/admin/classes/:classId/checkin", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) return;

  const { classId } = request.params;
  const today = new Date().toISOString().slice(0, 10);

  const { data: registrations, error: regError } = await dbClient
    .from("class_registrations")
    .select("member_id")
    .eq("class_id", classId);

  if (regError) {
    response.status(500).json({ error: regError.message });
    return;
  }

  if (!registrations || registrations.length === 0) {
    response.json([]);
    return;
  }

  const authUsers = await fetchAllAuthUsers();
  const emailMap = new Map(authUsers.map((u) => [u.id, u.email ?? ""]));

  const { data: attendance, error: attError } = await dbClient
    .from("attendance")
    .select("member_id, status")
    .eq("class_id", classId)
    .eq("session_date", today);

  if (attError) {
    response.status(500).json({ error: attError.message });
    return;
  }

  const statusMap = new Map((attendance ?? []).map((r) => [r.member_id, r.status]));

  const result = registrations.map((r: { member_id: string }) => ({
    id: r.member_id,
    email: emailMap.get(r.member_id) ?? r.member_id,
    checkedIn: statusMap.get(r.member_id) === "present"
  }));

  response.json(result);
});

// Admin: toggle check-in for a student (upserts attendance for today)
app.post("/api/admin/classes/:classId/checkin", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) return;

  const { classId } = request.params;
  const today = new Date().toISOString().slice(0, 10);

  const parsed = checkinToggleSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid check-in payload." });
    return;
  }

  const { error } = await dbClient
    .from("attendance")
    .upsert(
      {
        class_id: classId,
        member_id: parsed.data.memberId,
        session_date: today,
        status: parsed.data.checkedIn ? "present" : "absent",
        marked_by: user.id
      },
      { onConflict: "class_id,member_id,session_date" }
    );

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.json({ message: "Check-in updated." });
});

const groqChatSchema = z.object({
  message: z.string().min(1).max(2000)
});

app.post("/api/groq/chat", async (request, response) => {
  const user = await requireUser(request, response);
  if (!user) {
    return;
  }

  const parsed = groqChatSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Message must be between 1 and 2000 characters." });
    return;
  }

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant for a community classes platform. You help users find information about classes, scheduling, registration, and community programs. Be concise and friendly."
        },
        {
          role: "user",
          content: parsed.data.message
        }
      ],
      model: "llama-3.3-70b-versatile"
    });

    const reply = completion.choices[0]?.message?.content ?? "No response generated.";
    response.json({ reply });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Groq API error.";
    response.status(502).json({ error: message });
  }
});

const SEED_STUDENTS = [
  { email: "alex.turner@skate.test",    name: "Alex Turner" },
  { email: "jordan.lee@skate.test",     name: "Jordan Lee" },
  { email: "sam.parker@skate.test",     name: "Sam Parker" },
  { email: "riley.chen@skate.test",     name: "Riley Chen" },
  { email: "casey.morgan@skate.test",   name: "Casey Morgan" },
  { email: "taylor.brooks@skate.test",  name: "Taylor Brooks" },
  { email: "drew.williams@skate.test",  name: "Drew Williams" },
  { email: "quinn.davis@skate.test",    name: "Quinn Davis" },
  { email: "avery.johnson@skate.test",  name: "Avery Johnson" },
  { email: "morgan.smith@skate.test",   name: "Morgan Smith" },
  { email: "blake.harris@skate.test",   name: "Blake Harris" },
  { email: "charlie.nguyen@skate.test", name: "Charlie Nguyen" },
  { email: "dana.kim@skate.test",       name: "Dana Kim" },
  { email: "elliot.foster@skate.test",  name: "Elliot Foster" },
  { email: "fiona.reed@skate.test",     name: "Fiona Reed" },
  { email: "gabriel.stone@skate.test",  name: "Gabriel Stone" },
  { email: "hailey.cross@skate.test",   name: "Hailey Cross" },
  { email: "ivan.bell@skate.test",      name: "Ivan Bell" },
  { email: "jade.warren@skate.test",    name: "Jade Warren" },
  { email: "kai.murphy@skate.test",     name: "Kai Murphy" },
  { email: "lena.price@skate.test",     name: "Lena Price" },
  { email: "marcus.cole@skate.test",    name: "Marcus Cole" },
  { email: "nadia.hunt@skate.test",     name: "Nadia Hunt" },
  { email: "oliver.shaw@skate.test",    name: "Oliver Shaw" },
  { email: "paige.woods@skate.test",    name: "Paige Woods" },
  { email: "rex.grant@skate.test",      name: "Rex Grant" },
  { email: "sofia.lane@skate.test",     name: "Sofia Lane" },
  { email: "theo.banks@skate.test",     name: "Theo Banks" },
  { email: "uma.hayes@skate.test",      name: "Uma Hayes" },
  { email: "victor.ross@skate.test",    name: "Victor Ross" }
];

// Admin: seed test students via Supabase admin API
app.post("/api/admin/seed-students", async (request, response) => {
  const user = await requireUser(request, response, ["admin"]);
  if (!user) return;

  // Delete any SQL-seeded members that have no email in auth (show as raw UUIDs)
  const allAuthUsers = await fetchAllAuthUsers();
  const authEmailMap = new Map(allAuthUsers.map((u) => [u.id, u.email ?? ""]));
  const { data: memberRows } = await dbClient.from("users").select("id").eq("role", "member");
  for (const row of memberRows ?? []) {
    if (!authEmailMap.get(row.id)) {
      await dbClient.auth.admin.deleteUser(row.id);
    }
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const student of SEED_STUDENTS) {
    const { data, error } = await dbClient.auth.admin.createUser({
      email: student.email,
      password: "SkatePass1!",
      email_confirm: true
    });

    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists") || error.status === 422) {
        skipped.push(student.email);
      } else {
        failed.push(student.email);
      }
      continue;
    }

    const upsertError = await upsertUserRole(data.user.id, "member");
    if (upsertError) {
      failed.push(student.email);
    } else {
      created.push(student.email);
    }
  }

  response.json({ created, skipped, failed });
});

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
