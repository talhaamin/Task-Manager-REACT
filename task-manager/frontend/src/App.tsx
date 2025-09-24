import React, { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, Clock, Check, AlertCircle, Bell } from 'lucide-react';

const API_BASE = 'http://localhost:3001/api';

// === Your VAPID public key (safe to expose on frontend) ===
const VAPID_PUBLIC_KEY =
  'BNK5Vhu8k9nVl2fmpz29ldA-JhXxV8fRXK_9JAmnqcSrEN-10ognhDIW2rLHrd_XfTvX3wqw_4OdZSM3BO7245A';

// Utility: convert base64url string to Uint8Array (required by PushManager)

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

// Types
type TaskID = string | number;

interface Task {
  id: TaskID;
  title: string;
  dueDate?: string | null;
  completed: boolean;
}

type UpdatePayload = Partial<Task> & { input?: string };

export default function TaskManager() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskInput, setNewTaskInput] = useState<string>('');
  const [editingTask, setEditingTask] = useState<TaskID | null>(null);
  const [editInput, setEditInput] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // Push state
  const [pushEnabled, setPushEnabled] = useState<boolean>(false);
  const [pushChecking, setPushChecking] = useState<boolean>(true);

  useEffect(() => {
    void fetchTasks();
    const interval = setInterval(fetchTasks, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Check if there is an existing push subscription (to show correct button state)
  useEffect(() => {
    (async () => {
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          setPushChecking(false);
          return;
        }
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) {
          setPushChecking(false);
          return;
        }
        const sub = await reg.pushManager.getSubscription();
        setPushEnabled(!!sub);
      } catch {
        // ignore
      } finally {
        setPushChecking(false);
      }
    })();
  }, []);

  const fetchTasks = async (): Promise<void> => {
    try {
      const response = await fetch(`${API_BASE}/tasks`);
      if (response.ok) {
        const data: Task[] = await response.json();
        setTasks(data);
      }
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    }
  };

  const createTask = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!newTaskInput.trim()) return;

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: newTaskInput }),
      });

      if (response.ok) {
        const newTask: Task = await response.json();
        setTasks((prev) => [...prev, newTask]);
        setNewTaskInput('');
      } else {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to create task');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const updateTask = async (taskId: TaskID, updates: UpdatePayload): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (response.ok) {
        const updatedTask: Task = await response.json();
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updatedTask : t)));
        return true;
      }
    } catch (err) {
      console.error('Failed to update task:', err);
    }
    return false;
  };

  const deleteTask = async (taskId: TaskID): Promise<void> => {
    try {
      const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
      }
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const startEditing = (task: Task): void => {
    setEditingTask(task.id);
    const dueDateStr = task.dueDate ? ` due ${new Date(task.dueDate).toLocaleString()}` : '';
    setEditInput(task.title + dueDateStr);
  };

  const saveEdit = async (): Promise<void> => {
    if (!editingTask) return;
    if (await updateTask(editingTask, { input: editInput })) {
      setEditingTask(null);
      setEditInput('');
    }
  };

  const toggleComplete = async (task: Task): Promise<void> => {
    await updateTask(task.id, { completed: !task.completed });
  };

  // Enable push: register SW, request permission, subscribe, send subscription to backend
  const enablePushNotifications = async (): Promise<void> => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        alert('Push notifications are not supported in this browser.');
        return;
      }

      // Register service worker (must exist at /sw.js)
      const reg = await navigator.serviceWorker.register('/sw.js');

      // Ask permission
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        alert('Notification permission denied.');
        return;
      }

      // Subscribe
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      // Send to backend
      const resp = await fetch(`${API_BASE}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });

      if (!resp.ok) {
        throw new Error('Failed to save subscription on server');
      }

      setPushEnabled(true);
      alert('Push notifications enabled!');
    } catch (err) {
      console.error('Failed to enable push notifications:', err);
      alert('Error enabling push notifications. See console.');
    }
  };

  const formatDueDate = (dueDate?: string | null): string | null => {
    if (!dueDate) return null;
    const date = new Date(dueDate);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const isTomorrow =
      date.toDateString() === new Date(now.getTime() + 24 * 60 * 60 * 1000).toDateString();

    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    if (isToday) return `Today at ${time}`;
    if (isTomorrow) return `Tomorrow at ${time}`;
    return date.toLocaleDateString() + ' at ' + time;
  };

  type Status = 'completed' | 'no-due-date' | 'overdue' | 'due-soon' | 'upcoming';

  const getTaskStatus = (task: Task): Status => {
    if (task.completed) return 'completed';
    if (!task.dueDate) return 'no-due-date';

    const now = new Date();
    const due = new Date(task.dueDate);
    const hourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    if (due < now) return 'overdue';
    if (due < hourFromNow) return 'due-soon';
    return 'upcoming';
  };

  const getStatusColor = (status: Status): string => {
    switch (status) {
      case 'completed':
        return 'text-green-600 bg-green-50';
      case 'overdue':
        return 'text-red-600 bg-red-50';
      case 'due-soon':
        return 'text-orange-600 bg-orange-50';
      case 'upcoming':
        return 'text-blue-600 bg-blue-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  const pendingTasks = tasks.filter((t) => !t.completed);
  const completedTasks = tasks.filter((t) => t.completed);

  return (
    <div className="max-w-4xl mx-auto p-6 bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
      <div className="bg-white rounded-xl shadow-lg p-8">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">Smart Task Manager</h1>
        </header>

        {/* Push Notifications */}
        <div className="mb-6 flex justify-center">
          <button
            onClick={enablePushNotifications}
            disabled={pushEnabled || pushChecking}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
            title="Enable browser notifications"
          >
            <Bell size={18} />
            {pushChecking ? 'Checking...' : pushEnabled ? 'Push Enabled' : 'Enable Notifications'}
          </button>
        </div>

        {/* Add New Task */}
        {/* Add New Task */}
<div className="mb-8">
  <div className="flex flex-col sm:flex-row gap-3">
    <input
      type="text"
      value={newTaskInput}
      onChange={(e) => setNewTaskInput(e.target.value)}
      placeholder="What needs to be done? (e.g., 'Doctor appointment tomorrow at 2pm')"
      className="w-full sm:flex-1 min-w-0 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-lg"
      disabled={loading}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void createTask(e);
        }
      }}
    />
    <button
      onClick={(e) => void createTask(e)}
      disabled={loading || !newTaskInput.trim()}
      className="w-full sm:w-auto px-4 sm:px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
    >
      {loading ? (
        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
      ) : (
        <Plus size={20} />
      )}
      Add Task
    </button>
  </div>
  {error && (
    <div className="mt-2 text-red-600 text-sm flex items-center gap-2">
      <AlertCircle size={16} />
      {error}
    </div>
  )}
</div>

        {/* Task Lists */}
        <div className="grid md:grid-cols-2 gap-8">
          {/* Pending Tasks */}
          <div>
            <h2 className="text-2xl font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Clock size={24} />
              Pending ({pendingTasks.length})
            </h2>

            {pendingTasks.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <Clock size={48} className="mx-auto mb-4 opacity-50" />
                <p>No pending tasks. Add one above!</p>
              </div>
            ) : (
              <div className="space-y-3">
                {pendingTasks.map((task) => {
                  const status = getTaskStatus(task);
                  const isEditing = editingTask === task.id;

                  return (
                    <div
                      key={task.id}
                      className={`p-4 rounded-lg border-2 transition-all ${
                        status === 'overdue'
                          ? 'border-red-200 bg-red-50'
                          : status === 'due-soon'
                          ? 'border-orange-200 bg-orange-50'
                          : 'border-gray-200 bg-white hover:border-blue-300'
                      }`}
                    >
                      {isEditing ? (
                        <div className="space-y-3">
                          <input
                            type="text"
                            value={editInput}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditInput(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                              if (e.key === 'Enter') void saveEdit();
                              if (e.key === 'Escape') {
                                setEditingTask(null);
                                setEditInput('');
                              }
                            }}
                            autoFocus
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => void saveEdit()}
                              className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => {
                                setEditingTask(null);
                                setEditInput('');
                              }}
                              className="px-3 py-1 bg-gray-600 text-white rounded text-sm hover:bg-gray-700"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <h3 className="font-medium text-gray-800 mb-1">{task.title}</h3>
                            {task.dueDate && (
                              <div className={`text-sm px-2 py-1 rounded-full inline-block ${getStatusColor(status)}`}>
                                {formatDueDate(task.dueDate)}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-2 ml-4">
                            <button
                              onClick={() => void toggleComplete(task)}
                              className="p-2 text-green-600 hover:bg-green-100 rounded transition-colors"
                              title="Mark as complete"
                            >
                              <Check size={18} />
                            </button>
                            <button
                              onClick={() => startEditing(task)}
                              className="p-2 text-blue-600 hover:bg-blue-100 rounded transition-colors"
                              title="Edit task"
                            >
                              <Edit2 size={18} />
                            </button>
                            <button
                              onClick={() => void deleteTask(task.id)}
                              className="p-2 text-red-600 hover:bg-red-100 rounded transition-colors"
                              title="Delete task"
                            >
                              <Trash2 size={18} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Completed Tasks */}
          <div>
            <h2 className="text-2xl font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Check size={24} />
              Completed ({completedTasks.length})
            </h2>

            {completedTasks.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <Check size={48} className="mx-auto mb-4 opacity-50" />
                <p>No completed tasks yet.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {completedTasks.map((task) => (
                  <div key={task.id} className="p-4 rounded-lg border-2 border-green-200 bg-green-50 opacity-75">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h3 className="font-medium text-gray-700 line-through mb-1">{task.title}</h3>
                        <div className="text-sm text-green-600">✓ Completed</div>
                      </div>
                      <div className="flex gap-2 ml-4">
                        <button
                          onClick={() => void toggleComplete(task)}
                          className="p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors"
                          title="Mark as pending"
                        >
                          <Clock size={18} />
                        </button>
                        <button
                          onClick={() => void deleteTask(task.id)}
                          className="p-2 text-red-600 hover:bg-red-100 rounded transition-colors"
                          title="Delete task"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Examples */}
        <div className="mt-8 p-4 bg-blue-50 rounded-lg">
          <h3 className="font-semibold text-blue-800 mb-2">💡 Natural Language Examples:</h3>
          <div className="text-sm text-blue-700 grid md:grid-cols-2 gap-2">
            <div>• "Call dentist tomorrow at 2pm"</div>
            <div>• "Team meeting in 3 hours"</div>
            <div>• "Submit report by 5pm today"</div>
            <div>• "Grocery shopping tomorrow"</div>
            <div>• "Pick up kids at 3:30pm"</div>
            <div>• "Deadline 12/15 at 6pm"</div>
          </div>
          <p className="text-xs text-blue-600 mt-2">⏰ You’ll get automatic reminders 1 hour before each due time!</p>
        </div>
      </div>
    </div>
  );
}
