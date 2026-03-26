import { FormEvent, useEffect, useMemo, useState } from "react";

type AuthMode = "signup" | "login";
type UserRole = "admin" | "member" | "teacher";

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

type MemberClass = CommunityClass & {
  registrationCount: number;
  isRegistered: boolean;
};

type AuthResponse = {
  error?: string;
  message?: string;
  accessToken?: string | null;
  role?: UserRole;
};

type UserRecord = {
  id: string;
  email: string;
  role: UserRole;
};

type Teacher = {
  id: string;
  email: string;
};

const envApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
const apiBaseUrl = (envApiBaseUrl || "http://localhost:4000").replace(/\/$/, "");

function apiUrl(path: string) {
  return `${apiBaseUrl}${path}`;
}

async function parseApiJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  const body = await response.text();
  if (body.trimStart().startsWith("<!DOCTYPE")) {
    throw new Error(
      "Received HTML instead of API JSON. Verify VITE_API_BASE_URL (no trailing slash) and that the API is reachable."
    );
  }

  throw new Error(`Unexpected response from API (${response.status}).`);
}

function roleTitle(role: UserRole) {
  if (role === "admin") return "Admin";
  if (role === "teacher") return "Teacher";
  return "Member";
}

export default function App() {
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<UserRole | null>(null);
  const [status, setStatus] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [classesLoading, setClassesLoading] = useState(false);
  const [adminClasses, setAdminClasses] = useState<CommunityClass[]>([]);
  const [memberClasses, setMemberClasses] = useState<MemberClass[]>([]);
  const [teacherClasses, setTeacherClasses] = useState<CommunityClass[]>([]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructorName, setInstructorName] = useState("");
  const [location, setLocation] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [capacity, setCapacity] = useState("20");
  const [selectedTeacherId, setSelectedTeacherId] = useState("");
  const [createLoading, setCreateLoading] = useState(false);

  const [teachers, setTeachers] = useState<Teacher[]>([]);

  const [users, setUsers] = useState<UserRecord[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [promotingUserId, setPromotingUserId] = useState<string | null>(null);

  const [registeringClassId, setRegisteringClassId] = useState<string | null>(null);

  // Teacher edit state
  const [editingClassId, setEditingClassId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editInstructorName, setEditInstructorName] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editStartsAt, setEditStartsAt] = useState("");
  const [editCapacity, setEditCapacity] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const [groqMessage, setGroqMessage] = useState("");
  const [groqReply, setGroqReply] = useState("");
  const [groqLoading, setGroqLoading] = useState(false);

  const dashboardTitle = useMemo(() => {
    if (!currentRole) return "Community Classes";
    return `${roleTitle(currentRole)} Dashboard`;
  }, [currentRole]);

  async function loadAdminClasses(token: string) {
    setClassesLoading(true);
    try {
      const response = await fetch(apiUrl("/api/admin/classes"), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await parseApiJson<CommunityClass[] | AuthResponse>(response);
      if (!response.ok) throw new Error((data as AuthResponse).error ?? "Could not load classes.");
      setAdminClasses(data as CommunityClass[]);
    } finally {
      setClassesLoading(false);
    }
  }

  async function loadTeachers(token: string) {
    const response = await fetch(apiUrl("/api/admin/teachers"), {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.ok) {
      const data = await parseApiJson<Teacher[]>(response);
      setTeachers(data);
    }
  }

  async function loadUsers(token: string) {
    setUsersLoading(true);
    try {
      const response = await fetch(apiUrl("/api/admin/users"), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await parseApiJson<UserRecord[] | AuthResponse>(response);
      if (!response.ok) throw new Error((data as AuthResponse).error ?? "Could not load users.");
      setUsers(data as UserRecord[]);
    } finally {
      setUsersLoading(false);
    }
  }

  async function loadMemberClasses(token: string) {
    setClassesLoading(true);
    try {
      const response = await fetch(apiUrl("/api/member/classes"), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await parseApiJson<MemberClass[] | AuthResponse>(response);
      if (!response.ok) throw new Error((data as AuthResponse).error ?? "Could not load classes.");
      setMemberClasses(data as MemberClass[]);
    } finally {
      setClassesLoading(false);
    }
  }

  async function loadTeacherClasses(token: string) {
    setClassesLoading(true);
    try {
      const response = await fetch(apiUrl("/api/teacher/classes"), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await parseApiJson<CommunityClass[] | AuthResponse>(response);
      if (!response.ok) throw new Error((data as AuthResponse).error ?? "Could not load classes.");
      setTeacherClasses(data as CommunityClass[]);
    } finally {
      setClassesLoading(false);
    }
  }

  async function loadDashboard(role: UserRole, token: string) {
    if (role === "admin") {
      await Promise.all([loadAdminClasses(token), loadTeachers(token), loadUsers(token)]);
      return;
    }
    if (role === "teacher") {
      await loadTeacherClasses(token);
      return;
    }
    await loadMemberClasses(token);
  }

  // Keep teachers list in sync when users change role
  useEffect(() => {
    if (accessToken && currentRole === "admin") {
      loadTeachers(accessToken);
    }
  }, [users]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthLoading(true);
    setStatus("");

    try {
      const endpoint = authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const response = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const data = await parseApiJson<AuthResponse>(response);

      if (!response.ok) {
        setStatus(data.error ?? "Authentication failed.");
        return;
      }

      if (!data.accessToken) {
        setStatus(data.message ?? "Account created. Confirm your email in Supabase settings before logging in.");
        return;
      }

      if (!data.role) {
        setStatus("Role was not returned by the API.");
        return;
      }

      setAccessToken(data.accessToken);
      setCurrentRole(data.role);
      setStatus(data.message ?? "Authenticated.");
      await loadDashboard(data.role, data.accessToken);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not reach the backend API.");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handlePromote(userId: string, role: UserRole) {
    if (!accessToken) return;
    setPromotingUserId(userId);
    setStatus("");

    try {
      const response = await fetch(apiUrl(`/api/admin/users/${userId}/promote`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ role })
      });

      const data = await parseApiJson<AuthResponse>(response);
      if (!response.ok) {
        setStatus(data.error ?? "Could not update role.");
        return;
      }

      setStatus(data.message ?? "Role updated.");
      await loadUsers(accessToken);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update role.");
    } finally {
      setPromotingUserId(null);
    }
  }

  async function handleCreateClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || currentRole !== "admin") {
      setStatus("Only admins can create classes.");
      return;
    }

    const capacityValue = Number(capacity);
    if (!Number.isInteger(capacityValue) || capacityValue <= 0) {
      setStatus("Capacity must be a positive number.");
      return;
    }

    const startsAtMs = Date.parse(startsAt);
    if (Number.isNaN(startsAtMs)) {
      setStatus("Start time must be a valid date and time.");
      return;
    }

    setCreateLoading(true);
    setStatus("");

    try {
      const response = await fetch(apiUrl("/api/admin/classes"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          title,
          description,
          instructorName,
          location,
          startsAt: new Date(startsAtMs).toISOString(),
          capacity: capacityValue,
          teacherId: selectedTeacherId || null
        })
      });

      const data = await parseApiJson<AuthResponse>(response);
      if (!response.ok) {
        setStatus(data.error ?? "Class creation failed.");
        return;
      }

      setStatus("Class created.");
      setTitle("");
      setDescription("");
      setInstructorName("");
      setLocation("");
      setStartsAt("");
      setCapacity("20");
      setSelectedTeacherId("");
      await loadAdminClasses(accessToken);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create class.");
    } finally {
      setCreateLoading(false);
    }
  }

  function startEditClass(item: CommunityClass) {
    setEditingClassId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
    setEditInstructorName(item.instructor_name);
    setEditLocation(item.location);
    // Convert ISO string to datetime-local format
    const d = new Date(item.starts_at);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    setEditStartsAt(local);
    setEditCapacity(String(item.capacity));
  }

  async function handleEditClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !editingClassId) return;

    const capacityValue = Number(editCapacity);
    if (!Number.isInteger(capacityValue) || capacityValue <= 0) {
      setStatus("Capacity must be a positive number.");
      return;
    }

    const startsAtMs = Date.parse(editStartsAt);
    if (Number.isNaN(startsAtMs)) {
      setStatus("Start time must be a valid date and time.");
      return;
    }

    setEditLoading(true);
    setStatus("");

    try {
      const response = await fetch(apiUrl(`/api/teacher/classes/${editingClassId}`), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          title: editTitle,
          description: editDescription,
          instructorName: editInstructorName,
          location: editLocation,
          startsAt: new Date(startsAtMs).toISOString(),
          capacity: capacityValue
        })
      });

      const data = await parseApiJson<CommunityClass | AuthResponse>(response);
      if (!response.ok) {
        setStatus((data as AuthResponse).error ?? "Could not update class.");
        return;
      }

      setStatus("Class updated.");
      setEditingClassId(null);
      await loadTeacherClasses(accessToken);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update class.");
    } finally {
      setEditLoading(false);
    }
  }

  async function handleRegister(classId: string) {
    if (!accessToken || currentRole !== "member") {
      setStatus("Only members can register for classes.");
      return;
    }

    setRegisteringClassId(classId);
    setStatus("");

    try {
      const response = await fetch(apiUrl("/api/member/registrations"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ classId })
      });

      const data = await parseApiJson<AuthResponse>(response);
      if (!response.ok) {
        setStatus(data.error ?? "Registration failed.");
        return;
      }

      setStatus(data.message ?? "Registration successful.");
      await loadMemberClasses(accessToken);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not complete registration.");
    } finally {
      setRegisteringClassId(null);
    }
  }

  async function handleGroqChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;

    setGroqLoading(true);
    setGroqReply("");

    try {
      const response = await fetch(apiUrl("/api/groq/chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ message: groqMessage })
      });

      const data = await parseApiJson<{ reply?: string; error?: string }>(response);
      if (!response.ok) {
        setGroqReply(data.error ?? "Could not get a response.");
        return;
      }

      setGroqReply(data.reply ?? "");
      setGroqMessage("");
    } catch (error) {
      setGroqReply(error instanceof Error ? error.message : "Could not reach the AI assistant.");
    } finally {
      setGroqLoading(false);
    }
  }

  function logout() {
    setAccessToken(null);
    setCurrentRole(null);
    setAdminClasses([]);
    setMemberClasses([]);
    setTeacherClasses([]);
    setUsers([]);
    setTeachers([]);
    setStatus("Logged out.");
  }

  return (
    <main className="page">
      <section className="panel">
        <header className="panel-header">
          <div>
            <h1>{dashboardTitle}</h1>
            <p>Local programs for neighbors, families, and lifelong learners.</p>
          </div>
          {accessToken && (
            <button type="button" className="ghost" onClick={logout}>
              Log Out
            </button>
          )}
        </header>

        {!accessToken ? (
          <form onSubmit={handleAuthSubmit} className="stack">
            <div className="toggle-row">
              <button
                type="button"
                className={authMode === "signup" ? "active" : ""}
                onClick={() => setAuthMode("signup")}
              >
                Sign Up
              </button>
              <button
                type="button"
                className={authMode === "login" ? "active" : ""}
                onClick={() => setAuthMode("login")}
              >
                Log In
              </button>
            </div>

            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Password (8+ characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
            <button type="submit" disabled={authLoading}>
              {authLoading ? "Please wait..." : authMode === "signup" ? "Create Member Account" : "Log In"}
            </button>
          </form>

        ) : currentRole === "admin" ? (
          <>
            {/* Create Class */}
            <form onSubmit={handleCreateClass} className="stack">
              <h2>Create a Class</h2>
              <input
                type="text"
                placeholder="Class title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
              <textarea
                placeholder="Class description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                required
              />
              <input
                type="text"
                placeholder="Instructor name"
                value={instructorName}
                onChange={(e) => setInstructorName(e.target.value)}
                required
              />
              <input
                type="text"
                placeholder="Location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                required
              />
              <div className="split">
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  required
                />
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                  required
                />
              </div>
              <select
                value={selectedTeacherId}
                onChange={(e) => setSelectedTeacherId(e.target.value)}
              >
                <option value="">— No teacher assigned —</option>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.email}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={createLoading}>
                {createLoading ? "Saving..." : "Add Class"}
              </button>
            </form>

            {/* All Classes */}
            <section className="stack">
              <h2>All Classes</h2>
              {classesLoading ? (
                <p>Loading classes...</p>
              ) : adminClasses.length === 0 ? (
                <p>No classes yet.</p>
              ) : (
                <ul className="class-list">
                  {adminClasses.map((item) => {
                    const assignedTeacher = teachers.find((t) => t.id === item.teacher_id);
                    return (
                      <li key={item.id} className="class-card">
                        <h3>{item.title}</h3>
                        <p>{item.description}</p>
                        <p><strong>Instructor:</strong> {item.instructor_name}</p>
                        <p><strong>Location:</strong> {item.location}</p>
                        <p><strong>Starts:</strong> {new Date(item.starts_at).toLocaleString()}</p>
                        <p><strong>Capacity:</strong> {item.capacity}</p>
                        {assignedTeacher && (
                          <p><strong>Teacher:</strong> {assignedTeacher.email}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Manage Users */}
            <section className="stack">
              <h2>Manage Users</h2>
              {usersLoading ? (
                <p>Loading users...</p>
              ) : users.length === 0 ? (
                <p>No users found.</p>
              ) : (
                <ul className="class-list">
                  {users.map((u) => (
                    <li key={u.id} className="class-card">
                      <p><strong>{u.email}</strong></p>
                      <p>Role: <em>{u.role}</em></p>
                      <div className="split">
                        {u.role !== "teacher" && (
                          <button
                            type="button"
                            disabled={promotingUserId === u.id}
                            onClick={() => handlePromote(u.id, "teacher")}
                          >
                            {promotingUserId === u.id ? "Updating..." : "Make Teacher"}
                          </button>
                        )}
                        {u.role !== "member" && (
                          <button
                            type="button"
                            className="ghost"
                            disabled={promotingUserId === u.id}
                            onClick={() => handlePromote(u.id, "member")}
                          >
                            {promotingUserId === u.id ? "Updating..." : "Make Member"}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>

        ) : currentRole === "teacher" ? (
          <section className="stack">
            <h2>My Assigned Classes</h2>
            {classesLoading ? (
              <p>Loading classes...</p>
            ) : teacherClasses.length === 0 ? (
              <p>No classes assigned to you yet.</p>
            ) : (
              <ul className="class-list">
                {teacherClasses.map((item) => (
                  <li key={item.id} className="class-card">
                    {editingClassId === item.id ? (
                      <form onSubmit={handleEditClass} className="stack">
                        <h3>Edit Class</h3>
                        <input
                          type="text"
                          placeholder="Class title"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          required
                        />
                        <textarea
                          placeholder="Class description"
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          rows={4}
                          required
                        />
                        <input
                          type="text"
                          placeholder="Instructor name"
                          value={editInstructorName}
                          onChange={(e) => setEditInstructorName(e.target.value)}
                          required
                        />
                        <input
                          type="text"
                          placeholder="Location"
                          value={editLocation}
                          onChange={(e) => setEditLocation(e.target.value)}
                          required
                        />
                        <div className="split">
                          <input
                            type="datetime-local"
                            value={editStartsAt}
                            onChange={(e) => setEditStartsAt(e.target.value)}
                            required
                          />
                          <input
                            type="number"
                            min={1}
                            max={1000}
                            value={editCapacity}
                            onChange={(e) => setEditCapacity(e.target.value)}
                            required
                          />
                        </div>
                        <div className="split">
                          <button type="submit" disabled={editLoading}>
                            {editLoading ? "Saving..." : "Save Changes"}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => setEditingClassId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <h3>{item.title}</h3>
                        <p>{item.description}</p>
                        <p><strong>Instructor:</strong> {item.instructor_name}</p>
                        <p><strong>Location:</strong> {item.location}</p>
                        <p><strong>Starts:</strong> {new Date(item.starts_at).toLocaleString()}</p>
                        <p><strong>Capacity:</strong> {item.capacity}</p>
                        <button type="button" onClick={() => startEditClass(item)}>
                          Edit Class
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

        ) : (
          <section className="stack">
            <h2>Available Classes</h2>
            {classesLoading ? (
              <p>Loading classes...</p>
            ) : memberClasses.length === 0 ? (
              <p>No classes are available yet.</p>
            ) : (
              <ul className="class-list">
                {memberClasses.map((item) => {
                  const isFull = item.registrationCount >= item.capacity;
                  return (
                    <li key={item.id} className="class-card">
                      <h3>{item.title}</h3>
                      <p>{item.description}</p>
                      <p><strong>Instructor:</strong> {item.instructor_name}</p>
                      <p><strong>Location:</strong> {item.location}</p>
                      <p><strong>Starts:</strong> {new Date(item.starts_at).toLocaleString()}</p>
                      <p><strong>Registered:</strong> {item.registrationCount}/{item.capacity}</p>
                      <button
                        type="button"
                        disabled={item.isRegistered || isFull || registeringClassId === item.id}
                        onClick={() => handleRegister(item.id)}
                      >
                        {item.isRegistered
                          ? "Registered"
                          : isFull
                            ? "Class Full"
                            : registeringClassId === item.id
                              ? "Registering..."
                              : "Register"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {accessToken && (
          <section className="stack">
            <h2>Ask AI Assistant</h2>
            <form onSubmit={handleGroqChat} className="stack">
              <textarea
                placeholder="Ask a question about classes, schedules, or anything else..."
                value={groqMessage}
                onChange={(e) => setGroqMessage(e.target.value)}
                rows={3}
                required
              />
              <button type="submit" disabled={groqLoading}>
                {groqLoading ? "Thinking..." : "Ask"}
              </button>
            </form>
            {groqReply && (
              <div className="groq-reply">
                <p>{groqReply}</p>
              </div>
            )}
          </section>
        )}

        {status && <p className="status">{status}</p>}
      </section>
    </main>
  );
}
