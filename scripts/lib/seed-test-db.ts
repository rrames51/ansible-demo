// Seeds a MySQL database with a schema shaped like the production dump
// (~/backups/mysql-all-20261027-121001.sql.gz) and populates it with test
// users. Can be used programmatically (from inttest) or via the CLI wrapper
// at scripts/seed-test-db.ts.
//
// Programmatic use:
//   import { seedTestDb } from './scripts/lib/seed-test-db';
//   const result = await seedTestDb(makeMysqlConfig({ password: '...' }), {
//     count: 20,
//     extraUsers: [{ email: 'nnescio@example.com', firstName: 'nnescio', lastName: 'user', password: 'pass', adminRole: 2 }],
//     passwords: { 'nnescio@example.com': 'pass' },
//   });
//
// CLI use:
//   node scripts/seed-test-db.ts --count 20 --extra-users extra-users.json
//
// Env (CLI only): MYSQL_HOST/PORT/USER/PASSWORD/DATABASE

import { z } from 'zod';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { logger } from './logger.ts';
import { makeMysqlConfig, type MysqlConfig } from './mysql-config.ts';

// Verbatim CREATE TABLE statements from the authorized production dump
// (~/backups/mysql-all-20261027-121001.sql.gz), so the importer runs against
// the real schema, not a paraphrase.
const DDL_ADMIN_ROLES = `CREATE TABLE \`AdminRoles\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(255) NOT NULL,
  \`permissions\` varchar(255) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=59 DEFAULT CHARSET=utf8mb3`;

const DDL_ADMINS = `CREATE TABLE \`Admins\` (
  \`email\` varchar(255) NOT NULL,
  \`password\` varchar(255) NOT NULL,
  \`firstName\` varchar(255) NOT NULL,
  \`lastName\` varchar(255) NOT NULL,
  \`role\` int DEFAULT NULL,
  \`last_login\` datetime DEFAULT NULL,
  \`status\` enum('active','inactive') NOT NULL DEFAULT 'active',
  \`mustChangePassword\` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (\`email\`),
  KEY \`role_idx\` (\`role\`),
  KEY \`idx_admins_last_login_status\` (\`last_login\`,\`status\`),
  CONSTRAINT \`RoleID\` FOREIGN KEY (\`role\`) REFERENCES \`AdminRoles\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3`;

const DDL_LEGACY_ADMINS = `CREATE TABLE \`admins\` (
  \`email\` varchar(100) NOT NULL,
  \`firstName\` varchar(50) NOT NULL,
  \`lastName\` varchar(50) NOT NULL,
  \`password\` varchar(128) NOT NULL,
  \`salt\` varchar(64) NOT NULL,
  \`roles\` varchar(1024) DEFAULT NULL,
  \`role\` varchar(32) NOT NULL DEFAULT 'Admin',
  \`status\` enum('active','inactive') NOT NULL DEFAULT 'active',
  \`last_login\` datetime DEFAULT NULL,
  PRIMARY KEY (\`email\`),
  UNIQUE KEY \`email_UNIQUE\` (\`email\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3`;

const DDL_USERS = `CREATE TABLE \`users\` (
  \`email\` varchar(100) NOT NULL,
  \`firstName\` varchar(50) NOT NULL,
  \`lastName\` varchar(50) NOT NULL,
  \`password\` varchar(128) NOT NULL,
  \`salt\` varchar(60) DEFAULT NULL,
  \`isVerified\` tinyint NOT NULL DEFAULT '1' COMMENT '0 for not verified, 1 for verified',
  \`previouslyVerified\` tinyint NOT NULL DEFAULT '1' COMMENT '0 for was not previously verified, 1 for previously verified',
  \`expirationDate\` datetime DEFAULT NULL,
  \`blocked\` tinyint NOT NULL DEFAULT '0' COMMENT '0 for not blocked, 1 for blocked',
  \`previouslyBlocked\` tinyint NOT NULL DEFAULT '0' COMMENT '0 for not previously blocked, 1 for previously blocked',
  \`companyName\` varchar(100) DEFAULT NULL,
  \`phoneNumber\` varchar(20) DEFAULT NULL,
  \`role\` varchar(50) DEFAULT 'General Public',
  \`subscriber_approved\` datetime DEFAULT NULL,
  \`last_login\` datetime DEFAULT NULL COMMENT 'Timestamp of last successful login -- updated on every login',
  \`verified\` tinyint(1) NOT NULL DEFAULT '0',
  \`verification_token\` varchar(64) DEFAULT NULL,
  \`verification_sent_at\` datetime DEFAULT NULL,
  \`verified_at\` datetime DEFAULT NULL,
  \`mustChangePassword\` tinyint(1) NOT NULL DEFAULT '0',
  \`isTestAccount\` tinyint(1) NOT NULL DEFAULT '0',
  \`lastLoginAt\` datetime DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`email\`),
  UNIQUE KEY \`email_UNIQUE\` (\`email\`),
  KEY \`idx_users_expiration\` (\`expirationDate\`),
  KEY \`idx_users_last_login\` (\`last_login\`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1`;

// Subset of the production `AdminRoles` table (verbatim rows).
export const DEFAULT_ADMIN_ROLES: readonly AdminRoleSpec[] = [
  { id: 2, name: 'Super Administrator', permissions: 'all' },
  { id: 4, name: 'Customer Support', permissions: 'customerSupport' },
  {
    id: 22,
    name: 'Student Administrator',
    permissions: 'manageMediaSources,manageAutoDelete,manageApprovals,graphs,backendAnalyst,viewAuditLog,manageAdministrators,manageMediaTransfer,customerSupport',
  },
  { id: 23, name: 'IT Manager', permissions: 'backendAnalyst,graphs,customerSupport,viewAuditLog' },
  { id: 24, name: 'Data Analyst', permissions: 'graphs,backendAnalyst' },
];

export interface AdminRoleSpec {
  readonly id: number;
  readonly name: string;
  readonly permissions: string;
}

export interface ExtraUserSpec {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly password?: string;
  /** dc.Admins role id (FK to AdminRoles). */
  readonly adminRole?: number;
  /** Legacy dc.admins string role; seeded with the dead hex+salt format. */
  readonly legacyRole?: 'SuperAdmin' | 'Admin';
  /** Write a dc.users (customer) row. */
  readonly customer?: boolean;
  /** Write a dc.users row in addition to the dc.Admins row (email overlap). */
  readonly alsoCustomer?: boolean;
  /** dc.Admins.status = 'inactive' (imported disabled). */
  readonly inactive?: boolean;
  /** dc.users.blocked = 1 (imported disabled). */
  readonly blocked?: boolean;
  /** dc.users.isVerified = 0 (imported disabled). */
  readonly unverified?: boolean;
  /** mustChangePassword = 1 (imported with UPDATE_PASSWORD required action). */
  readonly mustChange?: boolean;
}

export interface SeedTestDbOptions {
  /** Number of generated regular users to create (default: 10). */
  readonly count?: number;
  /** Additional specific users to create (from --extra-users JSON file). */
  readonly extraUsers?: readonly ExtraUserSpec[];
  /** Plaintext passwords keyed by email, for users that need bcrypt hashing. */
  readonly passwords?: Record<string, string>;
}

export interface SeedTestDbResult {
  readonly adminRoles: number;
  readonly usersCreated: number;
  readonly bcryptHashed: number;
}

const ExtraUserSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  password: z.string().min(1).optional(),
  adminRole: z.number().int().optional(),
  legacyRole: z.enum(['SuperAdmin', 'Admin']).optional(),
  customer: z.boolean().optional(),
  alsoCustomer: z.boolean().optional(),
  inactive: z.boolean().optional(),
  blocked: z.boolean().optional(),
  unverified: z.boolean().optional(),
  mustChange: z.boolean().optional(),
});

const SeedOptionsSchema = z.object({
  count: z.number().int().min(0).max(10000).default(10),
  extraUsers: z.array(ExtraUserSchema).default([]),
});

type ParsedSeedOptions = z.infer<typeof SeedOptionsSchema>;

// Pre-bcrypt dead credential format: 64-byte hex digest + separate salt.
const DEAD_HASH = '0'.repeat(64);
const DEAD_SALT = '0'.repeat(16);

function generateRandomEmail(index: number): string {
  return `testuser${index}@example.com`;
}

function generateRandomPassword(): string {
  return Buffer.from(crypto.randomUUID() + Date.now().toString()).toString('base64url').slice(0, 24);
}

/**
 * Seeds a MySQL database with the production-shaped schema and test users.
 *
 * Drops and recreates AdminRoles, Admins, admins (legacy), and users tables.
 * Inserts the default admin roles, then creates `count` generated users plus
 * any `extraUsers`. Users with passwords are bcrypt-hashed (cost 10); users
 * without passwords get the dead hex+salt format.
 *
 * Returns a result summary with counts.
 */
export async function seedTestDb(
  config: MysqlConfig,
  options: SeedTestDbOptions = {},
): Promise<SeedTestDbResult> {
  const parsed = SeedOptionsSchema.parse(options);
  const passwords = options.passwords ?? {};

  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });

  try {
    // Disable foreign key checks so we can drop tables in any order
    // (production dump does the same: FOREIGN_KEY_CHECKS=0).
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    await connection.query('DROP TABLE IF EXISTS `Admins`');
    await connection.query('DROP TABLE IF EXISTS `admins`');
    await connection.query('DROP TABLE IF EXISTS `users`');
    await connection.query('DROP TABLE IF EXISTS `AdminRoles`');
    await connection.query(DDL_ADMIN_ROLES);
    await connection.query(DDL_ADMINS);
    await connection.query(DDL_LEGACY_ADMINS);
    await connection.query(DDL_USERS);
    await connection.query('SET FOREIGN_KEY_CHECKS=1');

    for (const role of DEFAULT_ADMIN_ROLES) {
      await connection.query(
        'INSERT INTO `AdminRoles` (`id`, `name`, `permissions`) VALUES (?, ?, ?)',
        [role.id, role.name, role.permissions],
      );
    }

    let hashed = 0;
    let usersCreated = 0;

    // Generated regular users.
    for (let i = 0; i < parsed.count; i += 1) {
      const email = generateRandomEmail(i);
      const plaintext = generateRandomPassword();
      const hash = await bcrypt.hash(plaintext, 10);
      passwords[email] = plaintext;
      hashed += 1;
      usersCreated += 1;

      await connection.query(
        'INSERT INTO `Admins` (`email`, `password`, `firstName`, `lastName`, `role`, `status`, `mustChangePassword`) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [email, hash, `TestUser${i}`, 'User', 2, 'active', 0],
      );
      await connection.query(
        'INSERT INTO `users` (`email`, `firstName`, `lastName`, `password`, `salt`, `isVerified`, `blocked`, `mustChangePassword`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [email, `TestUser${i}`, 'User', hash, null, 1, 0, 0],
      );
    }

    // Extra specific users.
    for (const user of parsed.extraUsers) {
      let hash: string;
      if (user.password) {
        hash = await bcrypt.hash(user.password, 10);
        hashed += 1;
      } else {
        hash = DEAD_HASH;
      }
      usersCreated += 1;

      if (user.adminRole != null) {
        await connection.query(
          'INSERT INTO `Admins` (`email`, `password`, `firstName`, `lastName`, `role`, `status`, `mustChangePassword`) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            user.email,
            hash,
            user.firstName,
            user.lastName,
            user.adminRole,
            user.inactive === true ? 'inactive' : 'active',
            user.mustChange === true ? 1 : 0,
          ],
        );
      }

      if (user.legacyRole != null) {
        await connection.query(
          'INSERT INTO `admins` (`email`, `firstName`, `lastName`, `password`, `salt`, `role`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [user.email, user.firstName, user.lastName, hash, DEAD_SALT, user.legacyRole, 'active'],
        );
      }

      if (user.customer === true || user.alsoCustomer === true) {
        await connection.query(
          'INSERT INTO `users` (`email`, `firstName`, `lastName`, `password`, `salt`, `isVerified`, `blocked`, `mustChangePassword`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            user.email,
            user.firstName,
            user.lastName,
            hash,
            user.password ? null : DEAD_SALT,
            user.unverified === true ? 0 : 1,
            user.blocked === true ? 1 : 0,
            user.mustChange === true ? 1 : 0,
          ],
        );
      }
    }

    logger.log(
      `[seed] schema created; ${usersCreated} users, ${hashed} bcrypt-hashed`,
    );

    return {
      adminRoles: DEFAULT_ADMIN_ROLES.length,
      usersCreated,
      bcryptHashed: hashed,
    };
  } finally {
    await connection.end();
  }
}
