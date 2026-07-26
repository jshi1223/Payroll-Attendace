# KVSK Payroll System — Documentation

Version: 1.1 | Last Updated: July 2026

Welcome to the official documentation for the **KVSK Payroll & Attendance System**, a full-stack web application built for small to medium businesses to manage employee attendance, payroll computation, cash advances, salary/bale payments, and payslip generation.

---

## Available Documentation

| # | Document | Description |
|---|----------|-------------|
| 1 | [User Guide](user-guide.md) | Complete user manual for daily system operation |
| 2 | [Installation Guide](installation.md) | Step-by-step setup and configuration |
| 3 | [Architecture](architecture.md) | System architecture, flow, and design decisions |
| 4 | [API Reference](api-reference.md) | Complete API endpoint documentation |
| 5 | [Database Schema](database-schema.md) | Database tables, relationships, and indexes |
| 6 | [Developer Guide](developer-guide.md) | Development setup, testing, and contribution guide |

## Other Documentation Assets

| Asset | Location | Description |
|-------|----------|-------------|
| User Manual (Markdown) | [DOCUMENTATION.md](../DOCUMENTATION.md) | Comprehensive user manual at project root |
| Word Document (.docx) | `Payroll_System_Documentation.docx` | Generated technical documentation (Word format) |
| User Manual (.docx) | `Payroll_System_User_Manual.docx` | User manual in Word format |
| Doc Generator | [generate-docs.js](../generate-docs.js) | Script that generates the Word documentation |

To regenerate the Word documentation:
```bash
node generate-docs.js
```

---

## Quick Links

- **Live App:** http://localhost:3001
- **Project README:** ../README.md
- **Tech Stack:** Node.js, Express 5, PostgreSQL 16, Vanilla JS (SPA)
- **Desktop App:** Electron + electron-builder (Windows Portable)

---

## Key Features

- **Role-Based Access** — Admin and HR Staff with distinct permissions
- **Employee Management** — Full CRUD with photo upload, government IDs, and archiving
- **Attendance Tracking** — Weekly and monthly views, bulk marking, time-in/time-out
- **Payroll Computation** — Weekly and semi-monthly periods with automatic calculations
- **Cash Advances (Bale)** — Track and manage employee debt with carryover
- **Extra Payments** — Bonuses, adjustments, and additional earnings
- **Salary and Bale Payments** — Payment recording with balance validation
- **Payslip Generation** — Lock periods and generate finalized payslips
- **Audit Trail** — Complete action log for Admin review
- **Auto-Backup** — Daily database backups with retention management
- **Dark Mode** — Full theme toggle with localStorage persistence
- **Keyboard Shortcuts** — Quick navigation (1-5, arrow keys, Escape)

---

## Security Features

| Feature | Description |
|---------|-------------|
| Session Auth | HTTP-only cookies with 8-hour timeout |
| CSRF Protection | Token-based on all mutation endpoints |
| Rate Limiting | Global: 120 req/min, Write: 40 req/min |
| Login Lockout | Progressive lockout after 5 failed attempts |
| Helmet Middleware | HTTP security headers |
| bcrypt Hashing | Password storage with salt rounds |
| Input Validation | Server-side validation for all inputs |

---

## System Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | 18+ |
| PostgreSQL | 14+ (16 recommended) |
| npm | 9+ |
| RAM | 512 MB minimum |
| Storage | 1 GB minimum |

*End of Documentation Index*
