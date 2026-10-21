//! Identity-stable, journaled projection-tree engine.
//!
//! [`ProjectionRootIdentityLock`] owns a projection tree root and executes
//! crash-recoverable, journaled mutations on it: temporary-file preparation
//! and publication, atomic path exchanges, identity-bound removals, replayable
//! tree deletion driven by persisted manifests and tombstones, and quarantined
//! tree publication through private snapshot claims. Every mutation re-verifies
//! node identity (device/inode on Unix, volume/file-id on Windows) and content
//! digests at each commit boundary, journals enough evidence to replay after a
//! crash, and fails closed: interrupted or conflicting operations are rejected
//! so unexpected occupants are retained for review instead of being silently
//! discarded.

use napi::{bindgen_prelude::Buffer, Error, Result, Status};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{copy, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(feature = "test-fault-injection")]
use std::sync::atomic::AtomicU8;

#[cfg(windows)]
use std::fs;
#[cfg(windows)]
use std::path::{Component, PathBuf};

#[cfg(windows)]
use std::fs::OpenOptions;
#[cfg(windows)]
use std::io::Seek;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::io::IntoRawHandle;
#[cfg(any(windows, test))]
use std::path::Path;

#[cfg(unix)]
use std::ffi::CStr;
#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[napi]
pub struct ProjectionRootIdentityLock {
    file: Option<File>,
    #[cfg(windows)]
    root: PathBuf,
}

#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
#[cfg(windows)]
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
#[cfg(windows)]
const FILE_ATTRIBUTE_DEVICE: u32 = 0x0000_0040;
#[cfg(windows)]
const FILE_SHARE_READ: u32 = 0x0000_0001;
#[cfg(windows)]
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
#[cfg(windows)]
const FILE_SHARE_DELETE: u32 = 0x0000_0004;

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);
#[cfg(any(windows, test))]
const WINDOWS_OPERATION_RETRY_DELAYS_MS: [u64; 4] = [5, 10, 20, 40];
#[cfg(feature = "test-fault-injection")]
static MUTATION_BOUNDARY_FAULT: AtomicU8 = AtomicU8::new(0);

#[cfg(not(feature = "test-fault-injection"))]
struct DisabledMutationBoundaryFault;

#[cfg(not(feature = "test-fault-injection"))]
impl DisabledMutationBoundaryFault {
    fn compare_exchange(
        &self,
        _current: u8,
        _new: u8,
        _success: Ordering,
        _failure: Ordering,
    ) -> std::result::Result<u8, u8> {
        Err(0)
    }
}

#[cfg(not(feature = "test-fault-injection"))]
static MUTATION_BOUNDARY_FAULT: DisabledMutationBoundaryFault = DisabledMutationBoundaryFault;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetFileInformationByHandle(
        handle: *mut std::ffi::c_void,
        information: *mut WindowsFileInformation,
    ) -> i32;
    fn GetFileInformationByHandleEx(
        handle: *mut std::ffi::c_void,
        class: u32,
        information: *mut std::ffi::c_void,
        size: u32,
    ) -> i32;
    fn SetFileInformationByHandle(
        handle: *mut std::ffi::c_void,
        class: u32,
        information: *mut std::ffi::c_void,
        size: u32,
    ) -> i32;
    fn GetFinalPathNameByHandleW(
        handle: *mut std::ffi::c_void,
        path: *mut u16,
        count: u32,
        flags: u32,
    ) -> u32;
}

// NT-native rename entry point. `SetFileInformationByHandle(FileRenameInfo)`
// rejects a non-NULL `RootDirectory` with ERROR_INVALID_PARAMETER (os error
// 87) on Windows Server runners, so the handle-relative rename — the Windows
// analog of `renameat` — must go through `NtSetInformationFile`, which has
// supported `FILE_RENAME_INFORMATION.RootDirectory` on every NT release.
#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    fn NtSetInformationFile(
        handle: *mut std::ffi::c_void,
        io_status_block: *mut WindowsIoStatusBlock,
        information: *mut std::ffi::c_void,
        length: u32,
        class: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

#[cfg(windows)]
const FILE_DISPOSITION_INFO_CLASS: u32 = 4;
#[cfg(windows)]
const FILE_RENAME_INFORMATION_NT_CLASS: u32 = 10;
#[cfg(windows)]
const FILE_ID_BOTH_DIRECTORY_INFO_CLASS: u32 = 10;
#[cfg(windows)]
const FILE_ID_BOTH_DIRECTORY_RESTART_INFO_CLASS: u32 = 11;
#[cfg(windows)]
const ERROR_NO_MORE_FILES: i32 = 18;
#[cfg(windows)]
const DELETE_ACCESS: u32 = 0x0001_0000;
#[cfg(windows)]
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
#[cfg(windows)]
const GENERIC_READ: u32 = 0x8000_0000;
#[cfg(windows)]
const GENERIC_WRITE: u32 = 0x4000_0000;
#[cfg(windows)]
#[repr(C)]
struct WindowsFileDispositionInformation {
    delete_file: i32,
}

// Native `IO_STATUS_BLOCK`: a pointer-sized union
// (`NTSTATUS Status` / `PVOID Pointer`) followed by `ULONG_PTR Information`.
// Only the call's returned NTSTATUS is consumed; the block itself must still
// be valid writable memory for the kernel.
#[cfg(windows)]
#[repr(C)]
#[allow(dead_code)]
struct WindowsIoStatusBlock {
    status: isize,
    information: usize,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileInformation {
    file_attributes: u32,
    creation_time_low: u32,
    creation_time_high: u32,
    access_time_low: u32,
    access_time_high: u32,
    write_time_low: u32,
    write_time_high: u32,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileIdBothDirectoryInformation {
    next_entry_offset: u32,
    file_index: u32,
    creation_time: i64,
    last_access_time: i64,
    last_write_time: i64,
    change_time: i64,
    end_of_file: i64,
    allocation_size: i64,
    file_attributes: u32,
    file_name_length: u32,
    ea_size: u32,
    short_name_length: u8,
    short_name: [u16; 12],
    file_id: i64,
    file_name: [u16; 1],
}

#[napi]
impl ProjectionRootIdentityLock {
    #[napi(constructor)]
    pub fn new(path: String, expected_device: String, expected_inode: String) -> Result<Self> {
        #[cfg(windows)]
        {
            let root = windows_verbatim_root(path);
            let file = open_windows_root_directory(&root).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("could not lock projection root identity: {error}"),
                )
            })?;
            let (expected_device, expected_inode) =
                expected_identity(&expected_device, &expected_inode)?;
            let (device, inode) = windows_file_identity(&file)?;
            if device != expected_device || inode != expected_inode {
                return Err(Error::new(
                    Status::GenericFailure,
                    "projection root identity changed".to_owned(),
                ));
            }
            recover_windows_native_evidence_descriptors(&root, &file)?;
            return Ok(Self {
                file: Some(file),
                root,
            });
        }
        #[cfg(unix)]
        {
            let file = File::open(&path).map_err(projection_error)?;
            let metadata = file.metadata().map_err(projection_error)?;
            let (device, inode) = expected_identity(&expected_device, &expected_inode)?;
            if metadata.dev() != device || metadata.ino() != inode {
                return Err(Error::new(
                    Status::GenericFailure,
                    "projection root identity changed".to_owned(),
                ));
            }
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(projection_error("projection root is busy"));
            }
            Ok(Self { file: Some(file) })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (path, expected_device, expected_inode);
            Err(Error::new(
                Status::GenericFailure,
                "projection root identity locking is unavailable".to_owned(),
            ))
        }
    }

    #[napi]
    pub fn create_directory(&self, relative_path: String) -> Result<()> {
        #[cfg(unix)]
        {
            let synthetic = format!("{relative_path}/entry");
            let (directory, _) = self.open_parent(&synthetic, true)?;
            directory.sync_all().map_err(projection_error)?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, true)?;
            if !path.exists() {
                fs::create_dir(&path).map_err(|error| projection_path_error(&path, error))?;
            }
            reject_windows_reparse(&path)?;
            let directory = open_windows_directory(&path)?;
            directory.sync_all().map_err(projection_error)?;
            sync_windows_parent(&guards, self.file.as_ref())?;
            return Ok(());
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection directory creation is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn copy_file(&self, source: String, relative_path: String) -> Result<()> {
        #[cfg(unix)]
        {
            let mut source_file = File::open(source).map_err(projection_error)?;
            let (parent, name) = self.open_parent(&relative_path, true)?;
            let temporary = temporary_name(&name);
            remove_relative_file(&parent, &temporary);
            let mut target = create_relative_file(&parent, &temporary)?;
            let result = copy(&mut source_file, &mut target)
                .map_err(projection_error)
                .and_then(|_| target.sync_all().map_err(projection_error))
                .and_then(|_| publish_relative_file(&parent, &temporary, &name));
            if result.is_err() {
                remove_relative_file(&parent, &temporary);
            }
            return result;
        }
        #[cfg(windows)]
        {
            let bytes = fs::read(source).map_err(projection_error)?;
            return self.write_windows_file(&relative_path, &bytes);
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root copy is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn write_file(&self, relative_path: String, content: Buffer) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, true)?;
            let temporary = temporary_name(&name);
            remove_relative_file(&parent, &temporary);
            let mut target = create_relative_file(&parent, &temporary)?;
            let result = target
                .write_all(content.as_ref())
                .map_err(projection_error)
                .and_then(|_| target.sync_all().map_err(projection_error))
                .and_then(|_| publish_relative_file(&parent, &temporary, &name));
            if result.is_err() {
                remove_relative_file(&parent, &temporary);
            }
            return result;
        }
        #[cfg(windows)]
        {
            return self.write_windows_file(&relative_path, content.as_ref());
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root write is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn write_file_with_temporary(
        &self,
        relative_path: String,
        temporary_path: String,
        content: Buffer,
    ) -> Result<()> {
        if relative_path
            .rsplit_once('/')
            .map(|value| value.0)
            .unwrap_or("")
            != temporary_path
                .rsplit_once('/')
                .map(|value| value.0)
                .unwrap_or("")
            || !temporary_path
                .rsplit_once('/')
                .map(|value| value.1)
                .unwrap_or(&temporary_path)
                .starts_with(".gsd-projection-tmp-")
        {
            return Err(Error::new(
                Status::InvalidArg,
                "projection temporary path is not journal-bound".to_owned(),
            ));
        }
        let identity = self.prepare_file_temporary(temporary_path.clone(), content)?;
        self.publish_file_temporary(relative_path, temporary_path, identity)
    }

    #[napi]
    pub fn prepare_file_temporary(
        &self,
        temporary_path: String,
        content: Buffer,
    ) -> Result<String> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&temporary_path, true)?;
            let mut file = create_relative_file(&parent, &name)?;
            file.write_all(content.as_ref()).map_err(projection_error)?;
            file.sync_all().map_err(projection_error)?;
            parent.sync_all().map_err(projection_error)?;
            let metadata = file.metadata().map_err(projection_error)?;
            return Ok(format!("{}:{}", metadata.dev(), metadata.ino()));
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&temporary_path, true)?;
            let mut file = OpenOptions::new()
                .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES | GENERIC_WRITE)
                // `access_mode` supplies the real desired access; `write(true)` is
                // still required so Windows `get_creation_mode` accepts `create_new`.
                .write(true)
                .create_new(true)
                .share_mode(0x0000_0001 | 0x0000_0002 | FILE_SHARE_DELETE)
                .open(&path)
                .map_err(|error| projection_path_error(&path, error))?;
            file.write_all(content.as_ref()).map_err(projection_error)?;
            file.sync_all().map_err(projection_error)?;
            sync_windows_parent(&guards, self.file.as_ref())?;
            let (volume, id) = windows_file_identity(&file)?;
            return Ok(format!("{volume}:{id}"));
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "projection temporary preparation is unavailable",
        ))
    }

    #[napi]
    pub fn prepare_directory_placeholder(&self, relative_path: String) -> Result<String> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, true)?;
            if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            parent.sync_all().map_err(projection_error)?;
            let node = open_relative_node(&parent, &name, true)?;
            let metadata = node.metadata().map_err(projection_error)?;
            return Ok(format!("{}:{}", metadata.dev(), metadata.ino()));
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, true)?;
            fs::create_dir(&path).map_err(|error| projection_path_error(&path, error))?;
            let node = open_windows_directory(&path)?;
            node.sync_all().map_err(projection_error)?;
            sync_windows_parent(&guards, self.file.as_ref())?;
            let (volume, id) = windows_file_identity(&node)?;
            return Ok(format!("{volume}:{id}"));
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "projection placeholder preparation is unavailable",
        ))
    }

    #[napi]
    pub fn exchange_paths(
        &self,
        left_path: String,
        right_path: String,
        left_identity: String,
        right_identity: String,
        guard_path: String,
        guard_identity: String,
    ) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, left) = self.open_parent(&left_path, false)?;
            let (right_parent, right) = self.open_parent(&right_path, false)?;
            let parent_identity = parent.metadata().map_err(projection_error)?;
            let right_parent_identity = right_parent.metadata().map_err(projection_error)?;
            if (parent_identity.dev(), parent_identity.ino())
                != (right_parent_identity.dev(), right_parent_identity.ino())
            {
                return Err(projection_error(
                    "projection exchange parent identity changed",
                ));
            }
            let (guard_parent, guard) = self.open_parent(&guard_path, false)?;
            let guard_parent_identity = guard_parent.metadata().map_err(projection_error)?;
            if (parent_identity.dev(), parent_identity.ino())
                != (guard_parent_identity.dev(), guard_parent_identity.ino())
            {
                return Err(projection_error(
                    "projection exchange guard parent identity changed",
                ));
            }
            loop {
                let left_actual = relative_identity(&parent, &left)?;
                let right_actual = relative_identity(&parent, &right)?;
                let guard_actual = relative_identity(&parent, &guard)?;
                if left_actual.as_deref() == Some(&right_identity)
                    && right_actual.as_deref() == Some(&left_identity)
                {
                    if guard_actual.is_none() {
                        return Ok(());
                    }
                    if guard_actual.as_deref() != Some(&guard_identity) {
                        return Err(projection_error(
                            "projection exchange guard identity changed after completion",
                        ));
                    }
                    return remove_node_at(
                        &parent,
                        &guard,
                        relative_is_directory(&parent, &guard)?,
                        Some(parse_unix_identity(&guard_identity)?),
                    );
                }
                if left_actual.as_deref() == Some(&left_identity)
                    && right_actual.as_deref() == Some(&right_identity)
                    && guard_actual.as_deref() == Some(&guard_identity)
                {
                    exchange_relative(&parent, &right, &guard)?;
                } else if left_actual.as_deref() == Some(&left_identity)
                    && right_actual.as_deref() == Some(&guard_identity)
                    && guard_actual.as_deref() == Some(&right_identity)
                {
                    exchange_relative(&parent, &left, &guard)?;
                } else if left_actual.as_deref() == Some(&right_identity)
                    && right_actual.as_deref() == Some(&guard_identity)
                    && guard_actual.as_deref() == Some(&left_identity)
                {
                    exchange_relative(&parent, &right, &guard)?;
                } else if left_actual.as_deref() == Some(&left_identity)
                    && right_actual.as_deref() == Some(&guard_identity)
                    && guard_actual.as_deref() != Some(&right_identity)
                {
                    parent.sync_all().map_err(projection_error)?;
                    return Err(projection_error(
                        "projection identity changed during journaled exchange; unexpected occupant retained in guard",
                    ));
                } else {
                    return Err(projection_error(
                        "projection identity changed during journaled exchange",
                    ));
                }
                parent.sync_all().map_err(projection_error)?;
            }
        }
        #[cfg(windows)]
        {
            let (left, guards) = self.safe_windows_path(&left_path, false)?;
            let (right, right_guards) = self.safe_windows_path(&right_path, false)?;
            let (guard, guard_guards) = self.safe_windows_path(&guard_path, false)?;
            loop {
                let left_file = open_windows_delete_node_if_exists(&left)?;
                let right_file = open_windows_delete_node_if_exists(&right)?;
                let guard_file = open_windows_delete_node_if_exists(&guard)?;
                let left_actual = left_file
                    .as_ref()
                    .map(windows_identity_string)
                    .transpose()?;
                let right_actual = right_file
                    .as_ref()
                    .map(windows_identity_string)
                    .transpose()?;
                let guard_actual = guard_file
                    .as_ref()
                    .map(windows_identity_string)
                    .transpose()?;
                if left_actual.as_deref() == Some(&right_identity)
                    && right_actual.as_deref() == Some(&left_identity)
                    && guard_actual.is_none()
                {
                    return Ok(());
                }
                if left_actual.as_deref() == Some(&left_identity)
                    && right_actual.as_deref() == Some(&right_identity)
                    && guard_actual.as_deref() == Some(&guard_identity)
                {
                    delete_windows_handle(guard_file.unwrap(), false)?;
                } else if left_actual.as_deref() == Some(&left_identity)
                    && right_actual.as_deref() == Some(&right_identity)
                    && guard_actual.is_none()
                {
                    drop(left_file);
                    let right_file = right_file.unwrap();
                    rename_windows_handle(
                        &right_file,
                        &guard,
                        guard_guards.last().or(self.file.as_ref()),
                    )?;
                    drop(right_file);
                } else if left_actual.as_deref() == Some(&left_identity)
                    && right_actual.is_none()
                    && guard_actual.as_deref() == Some(&right_identity)
                {
                    let left_file = left_file.unwrap();
                    drop(guard_file);
                    rename_windows_handle(
                        &left_file,
                        &right,
                        right_guards.last().or(self.file.as_ref()),
                    )?;
                    drop(left_file);
                } else if left_actual.is_none()
                    && right_actual.as_deref() == Some(&left_identity)
                    && guard_actual.as_deref() == Some(&right_identity)
                {
                    drop(right_file);
                    let guard_file = guard_file.unwrap();
                    rename_windows_handle(
                        &guard_file,
                        &left,
                        guards.last().or(self.file.as_ref()),
                    )?;
                    drop(guard_file);
                } else {
                    // Diagnostic detail is permanent, not debug scaffolding: this
                    // arm fires only when an occupant identity no longer matches
                    // the journaled exchange, and the expected/actual triples are
                    // the only way to identify the diverging slot from CI logs.
                    return Err(projection_error(format!(
                        "projection identity changed during journaled exchange: \
                        left {} expected {left_identity} actual {left_actual:?}; \
                        right {} expected {right_identity} actual {right_actual:?}; \
                        guard {} expected {guard_identity} actual {guard_actual:?}",
                        left.display(),
                        right.display(),
                        guard.display(),
                    )));
                }
                for parent in [right_guards.last(), guard_guards.last()]
                    .into_iter()
                    .flatten()
                {
                    parent.sync_all().map_err(projection_error)?;
                }
                sync_windows_parent(&guards, self.file.as_ref())?;
            }
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "atomic projection exchange is unavailable",
        ))
    }

    #[napi]
    pub fn path_identity(&self, relative_path: String) -> Result<String> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let descriptor = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let file = unsafe { File::from_raw_fd(descriptor) };
            let metadata = file.metadata().map_err(projection_error)?;
            return Ok(format!("{}:{}", metadata.dev(), metadata.ino()));
        }
        #[cfg(windows)]
        {
            self.recover_windows_control_for_path(&relative_path)?;
            let (path, _guards) = self.safe_windows_path(&relative_path, false)?;
            let file = open_windows_node(&path, false)?;
            let (volume, id) = windows_file_identity(&file)?;
            return Ok(format!("{volume}:{id}"));
        }
        #[allow(unreachable_code)]
        Err(projection_error("projection identity is unavailable"))
    }

    #[napi]
    pub fn remove_file_if_identity(&self, relative_path: String, identity: String) -> Result<()> {
        #[cfg(unix)]
        {
            let _ = (relative_path, identity);
            return Err(projection_error(
                "identity-bound removal requires a persisted guard",
            ));
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, false)?;
            let file = open_windows_delete_node(&path)?;
            require_windows_identity(&file, &identity, "projection file identity changed")?;
            delete_windows_handle(file, false)?;
            return sync_windows_parent(&guards, self.file.as_ref());
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "projection identity-bound removal is unavailable",
        ))
    }

    #[napi]
    pub fn remove_file_via_guard_exact(
        &self,
        relative_path: String,
        identity: String,
        guard_path: String,
        directory: bool,
        content_digest: String,
        deleting: Option<bool>,
    ) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let (guard_parent, guard) = self.open_parent(&guard_path, false)?;
            let source_parent = parent.metadata().map_err(projection_error)?;
            let destination_parent = guard_parent.metadata().map_err(projection_error)?;
            if (source_parent.dev(), source_parent.ino())
                != (destination_parent.dev(), destination_parent.ino())
            {
                return Err(projection_error(
                    "projection removal guard parent identity changed",
                ));
            }
            let source_name = if relative_identity(&parent, &guard)?.is_some() {
                &guard
            } else {
                &name
            };
            let deleting = directory && deleting == Some(true);
            let root = self
                .file
                .as_ref()
                .ok_or_else(|| projection_error("projection root is closed"))?;
            if deleting
                && completed_tree_deletion_tombstone_exists(
                    root,
                    &parent,
                    &guard,
                    &guard_path,
                    &identity,
                    &content_digest,
                )?
            {
                return Ok(());
            }
            let source = open_relative_node(&parent, source_name, directory)?;
            require_unix_identity(
                &source,
                &identity,
                "projection evidence identity changed before removal claim",
            )?;
            if unsafe { libc::flock(source.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(projection_error(
                    "projection evidence removal claim is busy",
                ));
            }
            if source_name == &name && name != guard {
                rename_open_relative(&parent, &name, &guard, &source)?;
                parent.sync_all().map_err(projection_error)?;
            }
            if deleting {
                reject_uncommitted_unix_tree_deletion_manifest(
                    &source,
                    &identity,
                    &content_digest,
                )?;
            }
            let deletion_replay = deleting && unix_tree_deletion_manifest_exists(&source)?;
            if !deletion_replay
                && projection_content_digest_at(&parent, &guard, directory)? != content_digest
            {
                return Err(projection_error(
                    "projection evidence content changed inside removal guard",
                ));
            }
            inject_unix_mutation_boundary_fault(&parent, &guard, &source, directory, false)?;
            require_relative_identity(
                &parent,
                &guard,
                &identity,
                "projection evidence identity changed at removal boundary",
            )?;
            if !deletion_replay
                && projection_content_digest_at(&parent, &guard, directory)? != content_digest
            {
                return Err(projection_error(
                    "projection evidence content changed inside removal guard",
                ));
            }
            return if deleting {
                remove_claimed_tree_at(
                    root,
                    &parent,
                    &guard,
                    &guard_path,
                    &source,
                    &identity,
                    &content_digest,
                )
            } else {
                remove_claimed_node_at(&parent, &guard, &source, directory)
            };
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, false)?;
            let (guard, guard_guards) = self.safe_windows_path(&guard_path, false)?;
            let file = match open_windows_exclusive_delete_node_if_exists(&guard)? {
                Some(file) => file,
                None => {
                    let file = open_windows_exclusive_delete_node(&path)?;
                    rename_windows_handle(
                        &file,
                        &guard,
                        guard_guards.last().or(self.file.as_ref()),
                    )?;
                    sync_windows_parent(&guards, self.file.as_ref())?;
                    file
                }
            };
            require_windows_identity(
                &file,
                &identity,
                "projection evidence identity changed inside removal guard",
            )?;
            let deleting = directory && deleting == Some(true);
            if deleting {
                reject_uncommitted_windows_tree_deletion_manifest(
                    &guard,
                    &identity,
                    &content_digest,
                )?;
            }
            let deletion_replay = deleting && windows_tree_deletion_manifest_exists(&guard);
            if !deletion_replay
                && windows_projection_content_digest_open(&guard, &file, directory)?
                    != content_digest
            {
                return Err(projection_error(
                    "projection evidence content changed inside removal guard",
                ));
            }
            require_windows_identity(
                &file,
                &identity,
                "projection evidence identity changed at removal boundary",
            )?;
            if !deletion_replay
                && windows_projection_content_digest_open(&guard, &file, directory)?
                    != content_digest
            {
                return Err(projection_error(
                    "projection evidence content changed inside removal guard",
                ));
            }
            if directory {
                if deleting {
                    remove_windows_claimed_tree_replayable(
                        &guard,
                        file,
                        &identity,
                        &content_digest,
                    )?;
                } else {
                    remove_windows_tree_open(&guard, file)?;
                }
            } else {
                delete_windows_handle(file, false)?;
            }
            return sync_windows_parent(&guards, self.file.as_ref());
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "exact guarded projection removal is unavailable",
        ))
    }

    #[napi]
    pub fn acknowledge_tree_deletion_evidence(
        &self,
        relative_path: String,
        identity: String,
    ) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let claimed = open_relative_node(&parent, &name, true)?;
            require_unix_identity(
                &claimed,
                &identity,
                "projection deletion evidence identity changed",
            )?;
            for manifest in [
                tree_deletion_manifest_name(),
                tree_deletion_prepared_manifest_name(),
            ] {
                if relative_identity(&claimed, &manifest)?.is_some() {
                    remove_node_at(&claimed, &manifest, false, None)?;
                }
            }
            claimed.sync_all().map_err(projection_error)?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, false)?;
            let directory = open_windows_exclusive_delete_node(&path)?;
            require_windows_identity(
                &directory,
                &identity,
                "projection deletion evidence identity changed",
            )?;
            let (committed, prepared) = windows_tree_deletion_manifest_paths(&path);
            for manifest in [committed, prepared] {
                if let Some(file) = open_windows_delete_node_if_exists(&manifest)? {
                    delete_windows_handle(file, false)?;
                }
            }
            directory.sync_all().map_err(projection_error)?;
            return sync_windows_parent(&guards, self.file.as_ref());
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "tree deletion evidence acknowledgement is unavailable",
        ))
    }

    #[napi]
    pub fn quarantine_file(
        &self,
        relative_path: String,
        quarantine_path: String,
    ) -> Result<String> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let (quarantine_parent, quarantine) = self.open_parent(&quarantine_path, false)?;
            let source_parent = parent.metadata().map_err(projection_error)?;
            let destination_parent = quarantine_parent.metadata().map_err(projection_error)?;
            if (source_parent.dev(), source_parent.ino())
                != (destination_parent.dev(), destination_parent.ino())
            {
                return Err(projection_error(
                    "projection quarantine parent identity changed",
                ));
            }
            let descriptor = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let file = unsafe { File::from_raw_fd(descriptor) };
            let metadata = file.metadata().map_err(projection_error)?;
            if !metadata.is_file() {
                return Err(projection_error("projection target is not a regular file"));
            }
            rename_open_relative(&parent, &name, &quarantine, &file)?;
            parent.sync_all().map_err(projection_error)?;
            return Ok(format!("{}:{}", metadata.dev(), metadata.ino()));
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, false)?;
            let (quarantine, quarantine_guards) =
                self.safe_windows_path(&quarantine_path, false)?;
            let file = open_windows_delete_node(&path)?;
            if windows_file_information(&file)?.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                return Err(projection_error("projection target is not a regular file"));
            }
            let (volume, id) = windows_file_identity(&file)?;
            rename_windows_handle(
                &file,
                &quarantine,
                quarantine_guards.last().or(self.file.as_ref()),
            )?;
            sync_windows_parent(&guards, self.file.as_ref())?;
            return Ok(format!("{volume}:{id}"));
        }
        #[allow(unreachable_code)]
        Err(projection_error("projection quarantine is unavailable"))
    }

    #[napi]
    pub fn quarantine_file_if_identity(
        &self,
        relative_path: String,
        quarantine_path: String,
        identity: String,
        placeholder_identity: String,
        guard_path: String,
        guard_identity: String,
    ) -> Result<()> {
        let result = self.exchange_paths(
            relative_path,
            quarantine_path.clone(),
            identity,
            placeholder_identity.clone(),
            guard_path,
            guard_identity,
        );
        if result.is_err() {
            let _ = self.remove_file_if_identity(quarantine_path, placeholder_identity);
        }
        result
    }

    #[napi]
    pub fn publish_file_temporary(
        &self,
        relative_path: String,
        temporary_path: String,
        identity: String,
    ) -> Result<()> {
        #[cfg(unix)]
        {
            let _ = relative_path;
            // Publication without a persisted exchange guard always fails on
            // unix; remove the journal-bound temporary so the rejected call
            // does not leak `.gsd-projection-tmp-*` evidence. Only a temporary
            // whose identity matches the prepared one is removed.
            let journal_bound = temporary_path
                .rsplit_once('/')
                .map(|value| value.1)
                .unwrap_or(&temporary_path)
                .starts_with(".gsd-projection-tmp-");
            if journal_bound {
                if let Ok((parent, temporary)) = self.open_parent(&temporary_path, false) {
                    if let Ok(Some(actual)) = relative_identity(&parent, &temporary) {
                        if actual == identity {
                            remove_relative_file(&parent, &temporary);
                        }
                    }
                }
            }
            return Err(projection_error(
                "temporary publication requires a persisted exchange guard",
            ));
        }
        #[cfg(windows)]
        {
            let (target, guards) = self.safe_windows_path(&relative_path, true)?;
            let (temporary, _temporary_guards) = self.safe_windows_path(&temporary_path, false)?;
            let file = open_windows_delete_node(&temporary)?;
            require_windows_identity(&file, &identity, "projection temporary identity changed")?;
            rename_windows_handle(&file, &target, guards.last().or(self.file.as_ref()))?;
            return sync_windows_parent(&guards, self.file.as_ref());
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "projection temporary publication is unavailable",
        ))
    }

    #[napi]
    pub fn read_file(&self, relative_path: String) -> Result<Buffer> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let descriptor = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let mut file = unsafe { File::from_raw_fd(descriptor) };
            if !file.metadata().map_err(projection_error)?.is_file() {
                return Err(Error::new(
                    Status::GenericFailure,
                    "projection root contains an unsupported node".to_owned(),
                ));
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(projection_error)?;
            return Ok(bytes.into());
        }
        #[cfg(windows)]
        {
            self.recover_windows_control_for_path(&relative_path)?;
            let (path, _guards) = self.safe_windows_path(&relative_path, false)?;
            let mut file = open_windows_file(&path, false)?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(projection_error)?;
            return Ok(bytes.into());
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root read is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn list_directory(&self, relative_path: String) -> Result<Vec<String>> {
        #[cfg(unix)]
        {
            let synthetic = if relative_path.is_empty() {
                "entry".to_owned()
            } else {
                format!("{relative_path}/entry")
            };
            let (parent, _) = self.open_parent(&synthetic, false)?;
            let descriptor = parent.into_raw_fd();
            let directory = unsafe { libc::fdopendir(descriptor) };
            if directory.is_null() {
                unsafe {
                    libc::close(descriptor);
                }
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let mut entries = Vec::new();
            clear_directory_scan_error();
            loop {
                let entry = unsafe { libc::readdir(directory) };
                if entry.is_null() {
                    if let Some(error) = directory_scan_error() {
                        unsafe {
                            libc::closedir(directory);
                        }
                        return Err(projection_error(error));
                    }
                    break;
                }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_string_lossy();
                if name != "." && name != ".." {
                    entries.push(name.into_owned());
                }
            }
            unsafe {
                libc::closedir(directory);
            }
            entries.sort();
            return Ok(entries);
        }
        #[cfg(windows)]
        {
            let (path, mut guards) = self.safe_windows_path(&relative_path, false)?;
            reject_windows_reparse(&path)?;
            // Enumerate the projection root through the identity-held handle
            // so the listing stays correlated with the locked root.
            if path != self.root {
                guards.push(open_windows_directory(&path)?);
            }
            let list_children = |guards: &[File]| -> Result<Vec<String>> {
                let directory = guards.last().or(self.file.as_ref()).ok_or_else(|| {
                    Error::new(
                        Status::GenericFailure,
                        "projection root is closed".to_owned(),
                    )
                })?;
                Ok(enumerate_windows_children(directory)?
                    .into_iter()
                    .map(|(name, _, _)| name)
                    .collect())
            };
            let mut entries = list_children(&guards)?;
            let intents = entries
                .iter()
                .filter_map(|name| {
                    let control = name.strip_prefix(".gsd-control-")?;
                    control
                        .strip_suffix(".intent.prepared")
                        .or_else(|| control.strip_suffix(".intent"))
                })
                .map(str::to_owned)
                .collect::<std::collections::BTreeSet<_>>();
            for target_name in &intents {
                recover_windows_control_publication(
                    &path.join(&target_name),
                    &path.join(format!(".gsd-control-{target_name}.temporary")),
                    &path.join(format!(".gsd-control-{target_name}.replaced")),
                    &path.join(format!(".gsd-control-{target_name}.intent")),
                    &path.join(format!(".gsd-control-{target_name}.intent.prepared")),
                    &guards,
                    self.file.as_ref(),
                    Some(&self.root),
                )?;
            }
            if !intents.is_empty() {
                entries = list_children(&guards)?;
            }
            entries.sort();
            return Ok(entries);
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root listing is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn path_exists(&self, relative_path: String) -> Result<bool> {
        #[cfg(unix)]
        {
            let parts = projection_parts(&relative_path)?;
            let root = self.file.as_ref().ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "projection root is closed".to_owned(),
                )
            })?;
            let duplicated = unsafe { libc::fcntl(root.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
            if duplicated < 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let mut parent = unsafe { File::from_raw_fd(duplicated) };
            for part in &parts[..parts.len() - 1] {
                let component = CString::new(part.as_bytes()).map_err(projection_error)?;
                let next = unsafe {
                    libc::openat(
                        parent.as_raw_fd(),
                        component.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if next < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() == Some(libc::ENOENT) {
                        return Ok(false);
                    }
                    return Err(projection_error(error));
                }
                parent = unsafe { File::from_raw_fd(next) };
            }
            let name = CString::new(parts.last().unwrap().as_bytes()).map_err(projection_error)?;
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            let result = unsafe {
                libc::fstatat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ENOENT) {
                    return Ok(false);
                }
                return Err(projection_error(error));
            }
            let mode = unsafe { stat.assume_init().st_mode } & libc::S_IFMT;
            if mode == libc::S_IFREG || mode == libc::S_IFDIR {
                return Ok(true);
            }
            if mode == libc::S_IFLNK {
                return Err(Error::new(
                    Status::GenericFailure,
                    "projection root contains an unsupported symbolic link".to_owned(),
                ));
            }
            return Err(Error::new(
                Status::GenericFailure,
                "projection root contains an unsupported node".to_owned(),
            ));
        }
        #[cfg(windows)]
        {
            self.recover_windows_control_for_path(&relative_path)?;
            return self.windows_path_exists(&relative_path);
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root existence check is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn path_kind(&self, relative_path: String) -> Result<String> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            let result = unsafe {
                libc::fstatat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result != 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let mode = unsafe { stat.assume_init().st_mode };
            if mode & libc::S_IFMT == libc::S_IFREG {
                return Ok("file".to_owned());
            }
            if mode & libc::S_IFMT == libc::S_IFDIR {
                return Ok("directory".to_owned());
            }
            return Err(Error::new(
                Status::GenericFailure,
                "projection root contains an unsupported node".to_owned(),
            ));
        }
        #[cfg(windows)]
        {
            self.recover_windows_control_for_path(&relative_path)?;
            let (path, _guards) = self.safe_windows_path(&relative_path, false)?;
            let file = open_windows_node(&path, false)?;
            let information = windows_file_information(&file)?;
            if information.file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Ok("file".to_owned());
            }
            if information.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                return Ok("directory".to_owned());
            }
            return Err(Error::new(
                Status::GenericFailure,
                "projection root contains an unsupported node".to_owned(),
            ));
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root type check is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn remove_file(&self, relative_path: String) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) };
            if result != 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            parent.sync_all().map_err(projection_error)?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, false)?;
            delete_windows_node(&path, false)?;
            sync_windows_parent(&guards, self.file.as_ref())?;
            return Ok(());
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root removal is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn remove_directory(&self, relative_path: String) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let result =
                unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) };
            if result != 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            parent.sync_all().map_err(projection_error)?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, false)?;
            delete_windows_node(&path, true)?;
            sync_windows_parent(&guards, self.file.as_ref())?;
            return Ok(());
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root directory removal is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn remove_tree(&self, relative_path: String) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            remove_tree_at(&parent, &name)?;
            parent.sync_all().map_err(projection_error)?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            self.remove_windows_tree(&relative_path)?;
            return Ok(());
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root recursive removal is unavailable".to_owned(),
        ))
    }

    #[napi]
    pub fn quarantine_tree(
        &self,
        relative_path: String,
        quarantine_path: String,
    ) -> Result<String> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&relative_path, false)?;
            let (quarantine_parent, quarantine) = self.open_parent(&quarantine_path, false)?;
            let descriptor = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let node = unsafe { File::from_raw_fd(descriptor) };
            let metadata = node.metadata().map_err(projection_error)?;
            rename_open_relative_between(&parent, &name, &quarantine_parent, &quarantine, &node)?;
            return Ok(format!("{}:{}", metadata.dev(), metadata.ino()));
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&relative_path, false)?;
            let (quarantine, quarantine_guards) =
                self.safe_windows_path(&quarantine_path, false)?;
            let node = open_windows_delete_node(&path)?;
            let (volume, id) = windows_file_identity(&node)?;
            rename_windows_handle(
                &node,
                &quarantine,
                quarantine_guards.last().or(self.file.as_ref()),
            )?;
            sync_windows_parent(&guards, self.file.as_ref())?;
            return Ok(format!("{volume}:{id}"));
        }
        #[allow(unreachable_code)]
        Err(projection_error("projection quarantine is unavailable"))
    }

    #[napi]
    pub fn quarantine_tree_if_identity(
        &self,
        relative_path: String,
        quarantine_path: String,
        identity: String,
        placeholder_identity: String,
        guard_path: String,
        guard_identity: String,
    ) -> Result<()> {
        let result = self.exchange_paths(
            relative_path,
            quarantine_path.clone(),
            identity,
            placeholder_identity.clone(),
            guard_path,
            guard_identity,
        );
        if result.is_err() {
            let _ = self.remove_quarantined_tree(quarantine_path, placeholder_identity);
        }
        result
    }

    #[napi]
    pub fn remove_quarantined_tree(&self, quarantine_path: String, identity: String) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(&quarantine_path, false)?;
            remove_node_at(&parent, &name, true, Some(parse_unix_identity(&identity)?))?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            let (path, guards) = self.safe_windows_path(&quarantine_path, false)?;
            let directory = open_windows_delete_node(&path)?;
            require_windows_identity(
                &directory,
                &identity,
                "projection quarantine identity changed",
            )?;
            remove_windows_tree_open(&path, directory)?;
            return sync_windows_parent(&guards, self.file.as_ref());
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "projection quarantine removal is unavailable",
        ))
    }

    #[napi]
    pub fn restore_quarantined_tree_exact(
        &self,
        quarantine_path: String,
        relative_path: String,
        identity: String,
        content_digest: String,
    ) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, quarantine) = self.open_parent(&quarantine_path, false)?;
            let (target_parent, target) = self.open_parent(&relative_path, false)?;
            return restore_quarantined_tree_from_snapshot_claim(
                self.file
                    .as_ref()
                    .ok_or_else(|| projection_error("projection root is closed"))?,
                &parent,
                &quarantine,
                &target_parent,
                &target,
                &identity,
                &content_digest,
            );
        }
        #[cfg(windows)]
        {
            let (quarantine, guards) = self.safe_windows_path(&quarantine_path, false)?;
            let (target, _target_guards) = self.safe_windows_path(&relative_path, false)?;
            return restore_windows_quarantined_tree_from_private_claim(
                &quarantine,
                &target,
                &identity,
                &content_digest,
                &guards,
                self.file.as_ref(),
            );
        }
        #[allow(unreachable_code)]
        Err(projection_error(
            "exact projection quarantine restoration is unavailable",
        ))
    }

    #[napi]
    pub fn sync_file(&self, relative_path: String) -> Result<()> {
        self.sync_relative(&relative_path, false)
    }

    #[napi]
    pub fn sync_directory(&self, relative_path: String) -> Result<()> {
        self.sync_relative(&relative_path, true)
    }

    #[napi]
    pub fn sync_root(&self) -> Result<()> {
        self.file
            .as_ref()
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "projection root is closed".to_owned(),
                )
            })?
            .sync_all()
            .map_err(projection_error)
    }

    #[napi]
    pub fn close(&mut self) -> Result<()> {
        let Some(file) = self.file.take() else {
            return Ok(());
        };
        #[cfg(windows)]
        {
            return close_windows_root_directory(file);
        }
        #[cfg(not(windows))]
        {
            drop(file);
            Ok(())
        }
    }
}

#[cfg(feature = "test-fault-injection")]
#[napi]
impl ProjectionRootIdentityLock {
    #[napi]
    pub fn set_mutation_boundary_fault_for_test(&self, fault: Option<String>) -> Result<()> {
        let value = match fault.as_deref() {
            None => 0,
            Some("remove-file-content") => 1,
            Some("remove-tree-content") => 2,
            Some("publish-tree-content") => 3,
            Some("remove-tree-crash") => 4,
            Some("remove-child-replacement") => 5,
            Some("publish-tree-crash") => 6,
            Some("remove-child-content") => 7,
            Some("publish-tree-final-content") => 8,
            Some("remove-tree-manifest-crash") => 9,
            Some("remove-tree-manifest-write-crash") => 10,
            Some("remove-child-final-replacement") => 11,
            Some("publish-tree-source-replacement") => 12,
            Some("publish-tree-new-descendant") => 13,
            Some("remove-tree-snapshot-child") => 14,
            Some("publish-tree-post-rename-crash") => 15,
            Some("publish-tree-final-source-content") => 16,
            Some("remove-tree-retirement-racer") => 17,
            Some("publish-tree-snapshot-copy-crash") => 18,
            Some("publish-tree-final-rename-racer") => 19,
            _ => {
                return Err(projection_error(
                    "unknown projection mutation boundary fault",
                ))
            }
        };
        MUTATION_BOUNDARY_FAULT.store(value, Ordering::SeqCst);
        Ok(())
    }
}

impl ProjectionRootIdentityLock {
    #[cfg(windows)]
    fn safe_windows_path(&self, relative_path: &str, create: bool) -> Result<(PathBuf, Vec<File>)> {
        if relative_path.is_empty() {
            return Ok((self.root.clone(), Vec::new()));
        }
        let parts = projection_parts(relative_path)?;
        let mut path = self.root.clone();
        let mut guards = Vec::new();
        for part in &parts[..parts.len() - 1] {
            path.push(part);
            if create && !path.exists() {
                fs::create_dir(&path).map_err(|error| projection_path_error(&path, error))?;
                sync_windows_parent(&guards, self.file.as_ref())?;
            }
            reject_windows_reparse(&path)?;
            guards.push(open_windows_directory(&path)?);
        }
        path.push(parts.last().unwrap());
        Ok((path, guards))
    }

    #[cfg(windows)]
    fn recover_windows_control_for_path(&self, relative_path: &str) -> Result<()> {
        let parts = projection_parts(relative_path)?;
        let mut path = self.root.clone();
        let mut guards = Vec::new();
        for part in &parts[..parts.len() - 1] {
            path.push(part);
            match fs::symlink_metadata(&path) {
                Ok(_) => reject_windows_reparse(&path)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(projection_path_error(&path, error)),
            }
            guards.push(open_windows_directory(&path)?);
        }
        // A root-level target leaves `path` equal to the projection root; scan
        // it through the identity-held handle instead of reopening by path.
        let directory = if path == self.root {
            self.file.as_ref()
        } else {
            None
        };
        recover_windows_control_directory(
            &path,
            directory,
            &guards,
            self.file.as_ref(),
            Some(&self.root),
        )
    }

    #[cfg(windows)]
    fn windows_path_exists(&self, relative_path: &str) -> Result<bool> {
        let parts = projection_parts(relative_path)?;
        let mut path = self.root.clone();
        let mut guards = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            path.push(part);
            match fs::symlink_metadata(&path) {
                Ok(_) => reject_windows_reparse(&path)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(projection_path_error(&path, error)),
            }
            if index + 1 < parts.len() {
                guards.push(open_windows_directory(&path)?);
            }
        }
        Ok(true)
    }

    #[cfg(windows)]
    fn write_windows_file(&self, relative_path: &str, content: &[u8]) -> Result<()> {
        let (target, guards) = self.safe_windows_path(relative_path, true)?;
        let target_name = target
            .file_name()
            .ok_or_else(|| projection_error("invalid target"))?;
        let temporary = target.with_file_name(format!(
            ".gsd-control-{}.temporary",
            target_name.to_string_lossy(),
        ));
        let replaced = target.with_file_name(format!(
            ".gsd-control-{}.replaced",
            target_name.to_string_lossy(),
        ));
        let later_evidence = target.with_file_name(format!(
            ".gsd-control-{}.later-evidence",
            target_name.to_string_lossy(),
        ));
        let intent = target.with_file_name(format!(
            ".gsd-control-{}.intent",
            target_name.to_string_lossy(),
        ));
        let prepared_intent = target.with_file_name(format!(
            ".gsd-control-{}.intent.prepared",
            target_name.to_string_lossy(),
        ));
        recover_windows_control_publication(
            &target,
            &temporary,
            &replaced,
            &intent,
            &prepared_intent,
            &guards,
            self.file.as_ref(),
            Some(&self.root),
        )?;
        let existing = match fs::symlink_metadata(&target) {
            Ok(_) => {
                let file = open_windows_delete_node(&target)?;
                if windows_file_information(&file)?.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0
                {
                    return Err(projection_error("projection target is not a regular file"));
                }
                Some(file)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(projection_path_error(&target, error)),
        };
        let old_identity = existing
            .as_ref()
            .map(windows_identity_string)
            .transpose()?
            .unwrap_or_else(|| "-".to_owned());
        let intent_bytes = encode_windows_control_intent(
            &target_name.to_string_lossy(),
            &temporary.file_name().unwrap().to_string_lossy(),
            &replaced.file_name().unwrap().to_string_lossy(),
            &later_evidence.file_name().unwrap().to_string_lossy(),
            &old_identity,
            "-",
            "prepared",
            content,
        )?;
        let prepared_intent_file = write_windows_control_intent(
            &prepared_intent,
            &intent_bytes,
            guards.last().or(self.file.as_ref()),
        )?;
        rename_windows_handle(
            &prepared_intent_file,
            &intent,
            guards.last().or(self.file.as_ref()),
        )?;
        // Release the DELETE-access rename handle before reopening the same
        // path. `open_windows_delete_node` requests READ|WRITE sharing without
        // FILE_SHARE_DELETE, which collides with this still-open handle and
        // yields ERROR_SHARING_VIOLATION (os error 32).
        drop(prepared_intent_file);
        sync_windows_parent(&guards, self.file.as_ref())?;
        let intent_file = open_windows_delete_node(&intent)?;
        let mut file = OpenOptions::new()
            .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES | GENERIC_WRITE)
            // `access_mode` supplies the real desired access; `write(true)` is
            // still required so Windows `get_creation_mode` accepts `create_new`.
            .write(true)
            .create_new(true)
            .share_mode(0x0000_0001 | 0x0000_0002 | FILE_SHARE_DELETE)
            .open(&temporary)
            .map_err(|error| projection_path_error(&temporary, error))?;
        file.write_all(content).map_err(projection_error)?;
        file.sync_all().map_err(projection_error)?;
        sync_windows_parent(&guards, self.file.as_ref())?;
        let new_identity = windows_identity_string(&file)?;
        let ready_intent = encode_windows_control_intent(
            &target_name.to_string_lossy(),
            &temporary.file_name().unwrap().to_string_lossy(),
            &replaced.file_name().unwrap().to_string_lossy(),
            &later_evidence.file_name().unwrap().to_string_lossy(),
            &old_identity,
            &new_identity,
            "temporary-durable",
            content,
        )?;
        let prepared_intent_file = write_windows_control_intent(
            &prepared_intent,
            &ready_intent,
            guards.last().or(self.file.as_ref()),
        )?;
        delete_windows_handle(intent_file, false)?;
        sync_windows_parent(&guards, self.file.as_ref())?;
        rename_windows_handle(
            &prepared_intent_file,
            &intent,
            guards.last().or(self.file.as_ref()),
        )?;
        // Release the DELETE-access rename handle before the reopen below so it
        // does not collide with `open_windows_delete_node`'s non-share-delete
        // access (ERROR_SHARING_VIOLATION / os error 32).
        drop(prepared_intent_file);
        sync_windows_parent(&guards, self.file.as_ref())?;
        let intent_file = open_windows_delete_node(&intent)?;
        publish_windows_file(
            file,
            &target,
            existing,
            &replaced,
            intent_file,
            &guards,
            self.file.as_ref(),
        )
    }

    #[cfg(windows)]
    fn remove_windows_tree(&self, relative_path: &str) -> Result<()> {
        let (path, guards) = self.safe_windows_path(relative_path, false)?;
        let directory = open_windows_delete_node(&path)?;
        remove_windows_tree_open(&path, directory)?;
        sync_windows_parent(&guards, self.file.as_ref())
    }

    #[cfg(unix)]
    fn open_parent(&self, relative_path: &str, create: bool) -> Result<(File, CString)> {
        let parts = projection_parts(relative_path)?;
        let name = CString::new(parts.last().unwrap().as_bytes()).map_err(projection_error)?;
        let root = self.file.as_ref().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "projection root is closed".to_owned(),
            )
        })?;
        let duplicated = unsafe { libc::fcntl(root.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if duplicated < 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
        let mut parent = unsafe { File::from_raw_fd(duplicated) };
        for part in &parts[..parts.len() - 1] {
            let component = CString::new(part.as_bytes()).map_err(projection_error)?;
            if create {
                let result =
                    unsafe { libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), 0o700) };
                if result == 0 {
                    parent.sync_all().map_err(projection_error)?;
                } else if std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                    return Err(projection_error(std::io::Error::last_os_error()));
                }
            }
            let descriptor = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    component.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            parent = unsafe { File::from_raw_fd(descriptor) };
        }
        Ok((parent, name))
    }

    fn sync_relative(&self, relative_path: &str, directory: bool) -> Result<()> {
        #[cfg(unix)]
        {
            let (parent, name) = self.open_parent(relative_path, false)?;
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | if directory { libc::O_DIRECTORY } else { 0 };
            let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
            if descriptor < 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let file = unsafe { File::from_raw_fd(descriptor) };
            return file.sync_all().map_err(projection_error);
        }
        #[cfg(windows)]
        {
            let (path, _guards) = self.safe_windows_path(relative_path, false)?;
            let file = if directory {
                open_windows_directory(&path)
            } else {
                open_windows_file(&path, true)
            }?;
            return file.sync_all().map_err(projection_error);
        }
        #[allow(unreachable_code)]
        Err(Error::new(
            Status::GenericFailure,
            "projection root sync is unavailable".to_owned(),
        ))
    }
}

fn projection_parts(relative_path: &str) -> Result<Vec<&str>> {
    let parts: Vec<_> = relative_path.split('/').collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains('\\'))
    {
        return Err(Error::new(
            Status::InvalidArg,
            "projection path is not canonical".to_owned(),
        ));
    }
    Ok(parts)
}

fn projection_error(error: impl std::fmt::Display) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("projection root operation failed: {error}"),
    )
}

#[cfg(any(windows, test))]
fn is_windows_sharing_violation(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(32)
}

/// Windows open/create/scan failures must name the path they faulted on: the
/// exclusively held (share_mode(0)) projection root rejects any by-path re-open
/// with ERROR_SHARING_VIOLATION (os error 32), and a bare "projection root
/// operation failed" gives no way to tell which open collided with the hold.
#[cfg(any(windows, test))]
fn projection_path_error(path: &Path, error: std::io::Error) -> Error {
    if is_windows_sharing_violation(&error) {
        return projection_error(format!(
            "transient projection root sharing violation at {}: another process holds an incompatible handle ({error})",
            path.display(),
        ));
    }
    projection_error(format!("{}: {error}", path.display()))
}

#[cfg(any(windows, test))]
fn retry_windows_projection_operation<T>(
    operation: &str,
    mut attempt_operation: impl FnMut() -> std::io::Result<T>,
    mut wait: impl FnMut(u64),
) -> Result<T> {
    for attempt in 0..=WINDOWS_OPERATION_RETRY_DELAYS_MS.len() {
        match attempt_operation() {
            Ok(value) => return Ok(value),
            Err(error) => {
                if is_windows_sharing_violation(&error) {
                    if let Some(delay_ms) = WINDOWS_OPERATION_RETRY_DELAYS_MS.get(attempt) {
                        wait(*delay_ms);
                        continue;
                    }
                    return Err(projection_error(format!(
                        "transient projection root sharing violation while {operation} after {} attempts: another process holds an incompatible handle ({error})",
                        attempt + 1,
                    )));
                }
                return Err(projection_error(format!("while {operation}: {error}")));
            }
        }
    }
    unreachable!("bounded Windows projection operation loop always returns")
}

/// Clears the thread-local errno before a readdir loop so a null return can
/// distinguish end-of-directory from an I/O error. Without this, an I/O error
/// would silently truncate listings that feed fail-closed occupant checks.
#[cfg(unix)]
fn clear_directory_scan_error() {
    unsafe {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            *libc::__errno_location() = 0;
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            *libc::__error() = 0;
        }
    }
}

/// Returns the pending readdir error after a null entry, or None at the real
/// end of the directory. Callers must have cleared errno via
/// `clear_directory_scan_error` before the loop.
#[cfg(unix)]
fn directory_scan_error() -> Option<std::io::Error> {
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(0) {
        None
    } else {
        Some(error)
    }
}

fn expected_identity(device: &str, inode: &str) -> Result<(u64, u64)> {
    Ok((
        device.parse::<u64>().map_err(projection_error)?,
        inode.parse::<u64>().map_err(projection_error)?,
    ))
}

#[cfg(windows)]
fn reject_windows_reparse(path: &Path) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| projection_path_error(path, error))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported reparse point".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn open_windows_directory(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        // Include FILE_SHARE_DELETE so this non-exclusive guard handle does not
        // block the single writer's own concurrent rename/delete of sibling
        // control files during a journaled publication or exchange
        // (ERROR_SHARING_VIOLATION / os error 32). Exclusivity, where required,
        // is expressed by the dedicated `share_mode(0)` helpers.
        .share_mode(0x0000_0001 | 0x0000_0002 | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| projection_path_error(path, error))?;
    let information = windows_file_information(&file)?;
    if information.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported reparse point".to_owned(),
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_windows_root_directory(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        // DELETE access with no delete sharing keeps the root identity pinned
        // and excludes a second mutation owner. Read/write sharing remains
        // available for the lock holder's own directory scans and child
        // publications.
        .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES | GENERIC_READ | GENERIC_WRITE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| projection_path_error(path, error))?;
    if windows_file_information(&file)?.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(projection_error(
            "projection root contains an unsupported reparse point",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn close_windows_root_directory(file: File) -> Result<()> {
    // Transfer ownership out of `File` and close the root handle explicitly so
    // close failures reach JavaScript instead of being discarded by `File`'s
    // infallible Drop. This is the only handle whose sharing contract excludes
    // another projection mutation owner.
    let handle = file.into_raw_handle();
    if unsafe { CloseHandle(handle) } == 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(windows)]
fn open_windows_node(path: &Path, write: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(write)
        // Include FILE_SHARE_DELETE so this non-exclusive node handle does not
        // collide with the single writer's own rename/delete of the same or
        // sibling nodes mid-operation (ERROR_SHARING_VIOLATION / os error 32).
        .share_mode(0x0000_0001 | 0x0000_0002 | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options
        .open(path)
        .map_err(|error| projection_path_error(path, error))?;
    let information = windows_file_information(&file)?;
    if information.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported reparse point".to_owned(),
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_windows_file(path: &Path, write: bool) -> Result<File> {
    let file = open_windows_node(path, write)?;
    if windows_file_information(&file)?.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported node".to_owned(),
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn delete_windows_node(path: &Path, directory: bool) -> Result<()> {
    delete_windows_handle(open_windows_delete_node(path)?, directory)
}

#[cfg(windows)]
fn open_windows_delete_node(path: &Path) -> Result<File> {
    let operation = format!("opening projection child at {}", path.display());
    let file = retry_windows_projection_operation(
        &operation,
        || {
            OpenOptions::new()
                .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES | GENERIC_READ | GENERIC_WRITE)
                // This is the shared (non-exclusive) delete-capable handle used to
                // rename/delete existing projection and control files during journaled
                // publication and exchange. It must include FILE_SHARE_DELETE so that
                // when several such handles to the target, temporary, replaced, intent,
                // and guard files are open at once, each other's rename/delete does not
                // fault with ERROR_SHARING_VIOLATION (os error 32). This mirrors the
                // FILE_SHARE_DELETE already carried by the temporary-file opens; callers
                // that require exclusivity use `open_windows_exclusive_delete_node`.
                .share_mode(0x0000_0001 | 0x0000_0002 | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
        },
        |delay_ms| std::thread::sleep(std::time::Duration::from_millis(delay_ms)),
    )?;
    let information = windows_file_information(&file)?;
    if information.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported node".to_owned(),
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_windows_exclusive_delete_node(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES | GENERIC_READ | GENERIC_WRITE)
        .share_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| projection_path_error(path, error))?;
    let information = windows_file_information(&file)?;
    if information.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported node".to_owned(),
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_windows_content_guard(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | GENERIC_READ | GENERIC_WRITE)
        .share_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| projection_path_error(path, error))?;
    if windows_file_information(&file)?.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(projection_error(
            "projection root contains an unsupported node",
        ));
    }
    Ok(file)
}

/// A frozen projection tree: every node is held open with an exclusive
/// content guard so the tree can be hashed through the guards themselves.
/// Re-reading any guarded node BY PATH would trip ERROR_SHARING_VIOLATION, so
/// all listing and hashing goes through the open handles.
#[cfg(windows)]
struct WindowsTreeContentGuard {
    file: File,
    name: String,
    directory: bool,
    children: Vec<WindowsTreeContentGuard>,
}

#[cfg(windows)]
impl WindowsTreeContentGuard {
    /// Drops the descendant guards and returns the root handle so the root
    /// can be renamed; Windows refuses to rename a directory while descendant
    /// handles without FILE_SHARE_DELETE are still open.
    fn into_root(self) -> File {
        let WindowsTreeContentGuard { file, .. } = self;
        file
    }
}

#[cfg(windows)]
fn guard_windows_tree_content(
    name: String,
    path: &Path,
    file: File,
) -> Result<WindowsTreeContentGuard> {
    let directory =
        windows_file_information(&file)?.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    let mut children = Vec::new();
    if directory {
        for (child_name, _child_id, _attributes) in enumerate_windows_children(&file)? {
            let child_path = path.join(&child_name);
            let child = open_windows_content_guard(&child_path)?;
            children.push(guard_windows_tree_content(child_name, &child_path, child)?);
        }
    }
    Ok(WindowsTreeContentGuard {
        file,
        name,
        directory,
        children,
    })
}

/// Hashes a guarded tree through the guard handles. The listing is
/// re-enumerated on every pass and compared against the captured guards so a
/// tree that changed inside its guards fails closed.
#[cfg(windows)]
fn hash_windows_guard_tree(
    guard: &WindowsTreeContentGuard,
    relative: &str,
    hash: &mut Sha256,
) -> Result<()> {
    if !guard.directory {
        hash.update(relative.as_bytes());
        hash.update(b"\0file\0");
        hash_windows_open_file(&guard.file, hash)?;
        hash.update(b"\0");
        return Ok(());
    }
    hash.update(relative.as_bytes());
    hash.update(b"\0directory\0");
    let current = enumerate_windows_children(&guard.file)?;
    if current.len() != guard.children.len() {
        return Err(projection_error(
            "projection tree occupants changed inside content guard",
        ));
    }
    for ((name, _child_id, attributes), child) in current.iter().zip(&guard.children) {
        if *name != child.name || (*attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != child.directory {
            return Err(projection_error(
                "projection tree occupants changed inside content guard",
            ));
        }
        let child_relative = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        hash_windows_guard_tree(child, &child_relative, hash)?;
    }
    Ok(())
}

#[cfg(windows)]
fn windows_guard_tree_content_digest(guard: &WindowsTreeContentGuard) -> Result<String> {
    let mut hash = Sha256::new();
    hash_windows_guard_tree(guard, "", &mut hash)?;
    Ok(format!("sha256:{:x}", hash.finalize()))
}

#[cfg(windows)]
fn restore_windows_quarantined_tree_from_private_claim(
    quarantine: &Path,
    target: &Path,
    identity: &str,
    content_digest: &str,
    guards: &[File],
    root: Option<&File>,
) -> Result<()> {
    let claim_hash = format!(
        "{:x}",
        Sha256::digest(
            format!("tree-publication\0{identity}\0{}", target.to_string_lossy()).as_bytes(),
        )
    );
    let claim = quarantine.with_file_name(format!(".gsd-publication-claim-{}", &claim_hash[..32]));
    let payload = claim.join("payload");
    if let Some(published) = open_windows_exclusive_delete_node_if_exists(target)? {
        require_windows_identity(
            &published,
            identity,
            "projection destination identity changed during publication replay",
        )?;
        if windows_projection_content_digest_open(target, &published, true)? != content_digest {
            return Err(projection_error(
                "projection destination content changed during publication replay",
            ));
        }
        if let Some(claim_handle) = open_windows_exclusive_delete_node_if_exists(&claim)? {
            if !enumerate_windows_children(&claim_handle)?.is_empty() {
                return Err(projection_error(
                    "projection publication claim has unexpected occupants",
                ));
            }
            delete_windows_handle(claim_handle, true)?;
            sync_windows_parent(guards, root)?;
        }
        return Ok(());
    }
    match fs::create_dir(&claim) {
        Ok(()) => sync_windows_parent(guards, root)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(projection_path_error(&claim, error)),
    }
    reject_windows_reparse(&claim)?;
    let claim_handle = open_windows_exclusive_delete_node(&claim)?;
    let directory = match open_windows_exclusive_delete_node_if_exists(&payload)? {
        Some(payload_handle) => {
            if open_windows_exclusive_delete_node_if_exists(quarantine)?.is_some() {
                return Err(projection_error(
                    "projection publication claim conflicts with its source",
                ));
            }
            payload_handle
        }
        None => {
            let source = open_windows_exclusive_delete_node(quarantine)?;
            require_windows_identity(
                &source,
                identity,
                "projection quarantine identity changed before publication claim",
            )?;
            if windows_projection_content_digest_open(quarantine, &source, true)? != content_digest
            {
                return Err(projection_error(
                    "projection quarantine content changed before publication claim",
                ));
            }
            rename_windows_handle(&source, &payload, Some(&claim_handle))?;
            claim_handle.sync_all().map_err(projection_error)?;
            sync_windows_parent(guards, root)?;
            source
        }
    };
    if enumerate_windows_children(&claim_handle)?.len() != 1 {
        return Err(projection_error(
            "projection publication claim has unexpected occupants",
        ));
    }
    require_windows_identity(
        &directory,
        identity,
        "projection quarantine identity changed inside publication claim",
    )?;
    let content_guard = guard_windows_tree_content(String::new(), &payload, directory)?;
    if windows_guard_tree_content_digest(&content_guard)? != content_digest {
        return Err(projection_error(
            "projection quarantine content changed inside publication claim",
        ));
    }
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(6, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return Err(projection_error("simulated tree publication crash"));
    }
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(8, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let changed = payload.join(".gsd-final-publication-fault");
        fs::write(&changed, b"changed at final publication boundary\n")
            .map_err(|error| projection_path_error(&changed, error))?;
        open_windows_delete_node(&changed)?
            .sync_all()
            .map_err(projection_error)?;
    }
    if windows_guard_tree_content_digest(&content_guard)? != content_digest {
        return Err(projection_error(
            "projection quarantine content changed at final publication boundary",
        ));
    }
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(13, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
        && fs::write(payload.join(".gsd-racing-descendant"), b"unreviewed\n").is_ok()
    {
        return Err(projection_error(
            "projection quarantine creation fence failed at final publication boundary",
        ));
    }
    // Drop the descendant content guards before renaming the root: Windows
    // refuses to rename a directory while descendant handles without
    // FILE_SHARE_DELETE are still open.
    let directory = content_guard.into_root();
    rename_windows_handle(&directory, target, guards.last().or(root))?;
    claim_handle.sync_all().map_err(projection_error)?;
    sync_windows_parent(guards, root)?;
    delete_windows_handle(claim_handle, true)?;
    sync_windows_parent(guards, root)
}

#[cfg(windows)]
fn open_windows_exclusive_delete_node_if_exists(path: &Path) -> Result<Option<File>> {
    match fs::symlink_metadata(path) {
        Ok(_) => open_windows_exclusive_delete_node(path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(projection_path_error(path, error)),
    }
}

#[cfg(windows)]
fn delete_windows_handle(file: File, directory: bool) -> Result<()> {
    let information = windows_file_information(&file)?;
    if (information.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported node".to_owned(),
        ));
    }
    let path_units = windows_handle_path(&file)?;
    let path = String::from_utf16_lossy(&path_units);
    let operation = format!("deleting projection child at {path}");
    retry_windows_projection_operation(
        &operation,
        || {
            let mut disposition = WindowsFileDispositionInformation { delete_file: 1 };
            let result = unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FILE_DISPOSITION_INFO_CLASS,
                    (&mut disposition as *mut WindowsFileDispositionInformation).cast(),
                    std::mem::size_of::<WindowsFileDispositionInformation>() as u32,
                )
            };
            if result == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        },
        |delay_ms| std::thread::sleep(std::time::Duration::from_millis(delay_ms)),
    )?;
    drop(file);
    Ok(())
}

#[cfg(windows)]
fn remove_windows_tree_open(path: &Path, directory: File) -> Result<()> {
    if windows_file_information(&directory)?.file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported node".to_owned(),
        ));
    }
    let parent_volume = windows_file_identity(&directory)?.0;
    let children = enumerate_windows_children(&directory)?;
    for (name, expected_id, expected_attributes) in children {
        let child_path = path.join(name);
        let child = open_windows_exclusive_delete_node(&child_path)?;
        let (volume, id) = windows_file_identity(&child)?;
        let attributes = windows_file_information(&child)?.file_attributes;
        if volume != parent_volume || id != expected_id || attributes != expected_attributes {
            return Err(Error::new(
                Status::GenericFailure,
                "projection child identity changed during removal".to_owned(),
            ));
        }
        if windows_file_information(&child)?.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            remove_windows_tree_open(&child_path, child)?;
        } else {
            delete_windows_handle(child, false)?;
        }
    }
    directory.sync_all().map_err(projection_error)?;
    delete_windows_handle(directory, true)
}

#[cfg(windows)]
fn enumerate_windows_children(directory: &File) -> Result<Vec<(String, u64, u32)>> {
    let mut children = Vec::new();
    // The first query restarts the handle's directory scan so repeated
    // enumerations of the same handle (for example before and after a content
    // proof) each see the full listing.
    let mut restart = true;
    loop {
        let mut buffer = vec![0u8; 64 * 1024];
        let class = if restart {
            FILE_ID_BOTH_DIRECTORY_RESTART_INFO_CLASS
        } else {
            FILE_ID_BOTH_DIRECTORY_INFO_CLASS
        };
        restart = false;
        let result = unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                class,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
            )
        };
        if result == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES) {
                break;
            }
            return Err(projection_error(error));
        }
        let mut offset = 0usize;
        loop {
            let entry = unsafe {
                &*(buffer.as_ptr().add(offset) as *const WindowsFileIdBothDirectoryInformation)
            };
            let name_length = entry.file_name_length as usize / std::mem::size_of::<u16>();
            let name = String::from_utf16(unsafe {
                std::slice::from_raw_parts(entry.file_name.as_ptr(), name_length)
            })
            .map_err(projection_error)?;
            if name != "." && name != ".." {
                children.push((name, entry.file_id as u64, entry.file_attributes));
            }
            if entry.next_entry_offset == 0 {
                break;
            }
            offset += entry.next_entry_offset as usize;
        }
    }
    children.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(children)
}

#[cfg(windows)]
fn windows_file_information(file: &File) -> Result<WindowsFileInformation> {
    let mut information = std::mem::MaybeUninit::<WindowsFileInformation>::zeroed();
    let result =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if result == 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    Ok(unsafe { information.assume_init() })
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> Result<(u64, u64)> {
    let information = windows_file_information(file)?;
    let inode = ((information.file_index_high as u64) << 32) | information.file_index_low as u64;
    Ok((information.volume_serial_number as u64, inode))
}

#[cfg(windows)]
fn require_windows_identity(file: &File, expected: &str, message: &str) -> Result<()> {
    let (volume, id) = windows_file_identity(file)?;
    if format!("{volume}:{id}") != expected {
        return Err(projection_error(message));
    }
    Ok(())
}

#[cfg(windows)]
fn publish_windows_file(
    temporary: File,
    target: &Path,
    existing: Option<File>,
    replaced: &Path,
    intent: File,
    guards: &[File],
    root: Option<&File>,
) -> Result<()> {
    if let Some(existing) = existing {
        rename_windows_handle(&existing, replaced, guards.last().or(root))?;
        sync_windows_parent(guards, root)?;
        if let Err(error) = rename_windows_handle(&temporary, target, guards.last().or(root)) {
            let _ = rename_windows_handle(&existing, target, guards.last().or(root));
            let _ = sync_windows_parent(guards, root);
            return Err(error);
        }
        sync_windows_parent(guards, root)?;
        delete_windows_handle(existing, false)?;
    } else {
        rename_windows_handle(&temporary, target, guards.last().or(root))?;
    }
    sync_windows_parent(guards, root)?;
    delete_windows_handle(intent, false)?;
    sync_windows_parent(guards, root)
}

#[cfg(windows)]
fn windows_identity_string(file: &File) -> Result<String> {
    let (volume, id) = windows_file_identity(file)?;
    Ok(format!("{volume}:{id}"))
}

#[cfg(windows)]
fn sync_windows_control_parent(path: &Path, parent: Option<&File>) -> Result<()> {
    if let Some(handle) = parent {
        return handle.sync_all().map_err(projection_error);
    }
    let directory = path
        .parent()
        .ok_or_else(|| projection_error("control publication path is invalid"))?;
    open_windows_directory(directory)?
        .sync_all()
        .map_err(projection_error)
}

#[cfg(windows)]
fn write_windows_control_intent(
    path: &Path,
    content: &[u8],
    parent: Option<&File>,
) -> Result<File> {
    let file_name = path
        .file_name()
        .ok_or_else(|| projection_error("control publication path is invalid"))?
        .to_string_lossy();
    let temporary_path = path.with_file_name(format!(
        ".{file_name}.write-{}",
        &format!("{:x}", Sha256::digest(content))[..32],
    ));
    if let Some(stale) = open_windows_delete_node_if_exists(&temporary_path)? {
        delete_windows_handle(stale, false)?;
        sync_windows_control_parent(path, parent)?;
    }
    let mut file = OpenOptions::new()
        .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES | GENERIC_READ | GENERIC_WRITE)
        // `access_mode` supplies the real desired access; `write(true)` is still
        // required so Windows `get_creation_mode` accepts `create_new`.
        .write(true)
        .create_new(true)
        .share_mode(0x0000_0001 | 0x0000_0002 | FILE_SHARE_DELETE)
        .open(&temporary_path)
        .map_err(|error| projection_path_error(&temporary_path, error))?;
    file.write_all(content).map_err(projection_error)?;
    file.sync_all().map_err(projection_error)?;
    rename_windows_handle(&file, path, parent)?;
    sync_windows_control_parent(path, parent)?;
    Ok(file)
}

#[cfg(windows)]
fn open_windows_delete_node_if_exists(path: &Path) -> Result<Option<File>> {
    match fs::symlink_metadata(path) {
        Ok(_) => open_windows_delete_node(path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(projection_path_error(path, error)),
    }
}

#[cfg(windows)]
struct WindowsControlIntent {
    sequence: u64,
    target_name: String,
    temporary_name: String,
    replaced_name: String,
    later_evidence_name: String,
    old_identity: String,
    new_identity: String,
    content_length: u64,
    content_digest: String,
    phase: String,
    target_evidence: String,
    temporary_evidence: String,
    replacement_evidence: String,
}

#[cfg(windows)]
fn control_content_digest(content: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(content))
}

/// Reads a file through an already-open handle into the digest. Callers hold
/// exclusive (share_mode(0)) handles, so re-reading the same node BY PATH
/// would fail with ERROR_SHARING_VIOLATION; mirroring the unix
/// `hash_open_file`, the content is read via the handle itself.
#[cfg(windows)]
fn hash_windows_open_file(file: &File, hash: &mut Sha256) -> Result<()> {
    let mut reader = file;
    reader.rewind().map_err(projection_error)?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(projection_error)?;
        if read == 0 {
            return Ok(());
        }
        hash.update(&buffer[..read]);
    }
}

#[cfg(windows)]
fn windows_open_file_content_digest(file: &File) -> Result<String> {
    let mut hash = Sha256::new();
    hash_windows_open_file(file, &mut hash)?;
    Ok(format!("sha256:{:x}", hash.finalize()))
}

/// Digests a node whose handle is already open (usually exclusively). The
/// given directory handle is enumerated through the handle; descendants are
/// opened by path because they are not yet exclusively held, then verified
/// against the enumerated identity before they contribute to the digest.
#[cfg(windows)]
fn windows_projection_content_digest_open(
    path: &Path,
    node: &File,
    directory: bool,
) -> Result<String> {
    let mut hash = Sha256::new();
    if directory {
        hash_windows_projection_tree_open(path, node, "", &mut hash)?;
    } else {
        hash_windows_open_file(node, &mut hash)?;
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

#[cfg(windows)]
fn hash_windows_projection_tree_open(
    path: &Path,
    directory: &File,
    relative: &str,
    hash: &mut Sha256,
) -> Result<()> {
    reject_windows_reparse(path)?;
    hash.update(relative.as_bytes());
    hash.update(b"\0directory\0");
    for (name, expected_id, attributes) in enumerate_windows_children(directory)? {
        let child = path.join(&name);
        reject_windows_reparse(&child)?;
        let child_handle = open_windows_node(&child, false)?;
        let (_, id) = windows_file_identity(&child_handle)?;
        if id != expected_id {
            return Err(projection_error(
                "projection child identity changed during content proof",
            ));
        }
        let child_relative = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            hash_windows_projection_tree_open(&child, &child_handle, &child_relative, hash)?;
        } else if attributes & FILE_ATTRIBUTE_DEVICE == 0 {
            hash.update(child_relative.as_bytes());
            hash.update(b"\0file\0");
            hash_windows_open_file(&child_handle, hash)?;
            hash.update(b"\0");
        } else {
            return Err(projection_error(
                "projection root contains an unsupported node",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
struct WindowsTreeDeletionEntry {
    path: String,
    identity: String,
    directory: bool,
    content_digest: Option<String>,
}

#[cfg(windows)]
fn windows_tree_deletion_manifest_paths(root: &Path) -> (PathBuf, PathBuf) {
    (
        root.join(".gsd-delete-manifest"),
        root.join(".gsd-delete-manifest.prepared"),
    )
}

#[cfg(windows)]
fn windows_tree_deletion_manifest_temporary_path(
    root: &Path,
    root_identity: &str,
    content_digest: &str,
) -> PathBuf {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("delete-manifest\0{root_identity}\0{content_digest}").as_bytes(),)
    );
    root.join(format!(".gsd-delete-manifest.write-{}", &digest[..32]))
}

#[cfg(windows)]
fn windows_tree_deletion_manifest_exists(root: &Path) -> bool {
    let (committed, prepared) = windows_tree_deletion_manifest_paths(root);
    committed.exists() || prepared.exists()
}

#[cfg(windows)]
fn reject_uncommitted_windows_tree_deletion_manifest(
    root: &Path,
    root_identity: &str,
    content_digest: &str,
) -> Result<()> {
    let temporary =
        windows_tree_deletion_manifest_temporary_path(root, root_identity, content_digest);
    if open_windows_exclusive_delete_node_if_exists(&temporary)?.is_some() {
        return Err(projection_error(
            "unrecognized deletion manifest temporary was retained",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn collect_windows_tree_deletion_entries(
    root: &Path,
    current: &Path,
    current_handle: &File,
    entries: &mut Vec<WindowsTreeDeletionEntry>,
) -> Result<()> {
    // `current` is held open exclusively by `current_handle`, so the listing
    // must come from the handle; each child is opened by path (children are
    // not yet held) and re-verified against the enumerated identity.
    let parent_volume = windows_file_identity(current_handle)?.0;
    for (name, expected_id, expected_attributes) in enumerate_windows_children(current_handle)? {
        let path = current.join(&name);
        let relative = path
            .strip_prefix(root)
            .map_err(projection_error)?
            .to_string_lossy()
            .replace('\\', "/");
        if relative == ".gsd-delete-manifest" || relative == ".gsd-delete-manifest.prepared" {
            return Err(projection_error(
                "projection tree contains a reserved deletion manifest",
            ));
        }
        let node = open_windows_exclusive_delete_node(&path)?;
        let (volume, id) = windows_file_identity(&node)?;
        let information = windows_file_information(&node)?;
        if volume != parent_volume
            || id != expected_id
            || information.file_attributes != expected_attributes
        {
            return Err(projection_error(
                "projection child identity changed during removal",
            ));
        }
        let directory = information.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        if directory {
            collect_windows_tree_deletion_entries(root, &path, &node, entries)?;
        }
        entries.push(WindowsTreeDeletionEntry {
            path: relative,
            identity: windows_identity_string(&node)?,
            directory,
            content_digest: if directory {
                None
            } else {
                Some(windows_open_file_content_digest(&node)?)
            },
        });
    }
    Ok(())
}

#[cfg(windows)]
fn encode_windows_tree_deletion_manifest(
    root_identity: &str,
    content_digest: &str,
    entries: &[WindowsTreeDeletionEntry],
) -> Result<Vec<u8>> {
    let payload = serde_json::json!({
        "version": 1,
        "rootIdentity": root_identity,
        "contentDigest": content_digest,
        "entries": entries.iter().map(|entry| serde_json::json!({
            "path": entry.path,
            "identity": entry.identity,
            "directory": entry.directory,
            "contentDigest": entry.content_digest,
        })).collect::<Vec<_>>(),
    });
    let payload_bytes = serde_json::to_vec(&payload).map_err(projection_error)?;
    serde_json::to_vec(&serde_json::json!({
        "checksum": control_content_digest(&payload_bytes),
        "payload": payload,
    }))
    .map_err(projection_error)
}

#[cfg(windows)]
fn decode_windows_tree_deletion_manifest(
    bytes: &[u8],
    root_identity: &str,
    content_digest: &str,
) -> Result<Vec<WindowsTreeDeletionEntry>> {
    let wrapper: serde_json::Value = serde_json::from_slice(bytes).map_err(projection_error)?;
    let payload = wrapper
        .get("payload")
        .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
    let payload_bytes = serde_json::to_vec(payload).map_err(projection_error)?;
    let expected_checksum = control_content_digest(&payload_bytes);
    if wrapper.get("checksum").and_then(serde_json::Value::as_str)
        != Some(expected_checksum.as_str())
        || payload.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || payload
            .get("rootIdentity")
            .and_then(serde_json::Value::as_str)
            != Some(root_identity)
        || payload
            .get("contentDigest")
            .and_then(serde_json::Value::as_str)
            != Some(content_digest)
    {
        return Err(projection_error("projection deletion manifest is invalid"));
    }
    let values = payload
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
    let mut entries = Vec::with_capacity(values.len());
    for value in values {
        let path = value
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
        if path.is_empty()
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(projection_error("projection deletion manifest is invalid"));
        }
        let identity = value
            .get("identity")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
        let directory = value
            .get("directory")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
        let entry_digest = value
            .get("contentDigest")
            .and_then(serde_json::Value::as_str);
        if directory != entry_digest.is_none() {
            return Err(projection_error("projection deletion manifest is invalid"));
        }
        entries.push(WindowsTreeDeletionEntry {
            path: path.to_owned(),
            identity: identity.to_owned(),
            directory,
            content_digest: entry_digest.map(str::to_owned),
        });
    }
    entries.sort_by(|left, right| {
        right
            .path
            .matches('/')
            .count()
            .cmp(&left.path.matches('/').count())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(entries)
}

#[cfg(windows)]
fn load_or_publish_windows_tree_deletion_manifest(
    root: &Path,
    root_handle: &File,
    root_identity: &str,
    content_digest: &str,
) -> Result<Vec<WindowsTreeDeletionEntry>> {
    let (committed, prepared) = windows_tree_deletion_manifest_paths(root);
    let temporary =
        windows_tree_deletion_manifest_temporary_path(root, root_identity, content_digest);
    if committed.exists() {
        let bytes =
            fs::read(&committed).map_err(|error| projection_path_error(&committed, error))?;
        let entries = decode_windows_tree_deletion_manifest(&bytes, root_identity, content_digest)?;
        if prepared.exists() {
            if fs::read(&prepared).map_err(|error| projection_path_error(&prepared, error))?
                != bytes
            {
                return Err(projection_error("projection deletion manifests conflict"));
            }
            delete_windows_handle(open_windows_delete_node(&prepared)?, false)?;
            root_handle.sync_all().map_err(projection_error)?;
        }
        return Ok(entries);
    }
    if prepared.exists() {
        let bytes = fs::read(&prepared).map_err(|error| projection_path_error(&prepared, error))?;
        let entries = decode_windows_tree_deletion_manifest(&bytes, root_identity, content_digest)?;
        let prepared_handle = open_windows_delete_node(&prepared)?;
        rename_windows_handle(&prepared_handle, &committed, Some(root_handle))?;
        root_handle.sync_all().map_err(projection_error)?;
        return Ok(entries);
    }
    if open_windows_delete_node_if_exists(&temporary)?.is_some() {
        return Err(projection_error(
            "unrecognized deletion manifest temporary was retained",
        ));
    }
    let mut entries = Vec::new();
    collect_windows_tree_deletion_entries(root, root, root_handle, &mut entries)?;
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(14, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let later_path = root.join("later-after-consent.md");
        fs::write(&later_path, b"later accepted work\n")
            .map_err(|error| projection_path_error(&later_path, error))?;
    }
    if windows_projection_content_digest_open(root, root_handle, true)? != content_digest {
        return Err(projection_error(
            "projection evidence content changed before deletion manifest commit",
        ));
    }
    let bytes = encode_windows_tree_deletion_manifest(root_identity, content_digest, &entries)?;
    let mut file = OpenOptions::new()
        .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE_ACCESS | FILE_READ_ATTRIBUTES)
        // `access_mode` supplies the real desired access; `write(true)` is still
        // required so Windows `get_creation_mode` accepts `create_new`.
        .write(true)
        .create_new(true)
        // Permit delete-sharing (matching the other journaled temporaries) so a
        // concurrent projection cleanup or the atomic rename that publishes this
        // deletion manifest cannot fail with a Windows sharing violation
        // (os error 32) while this handle is still open.
        .share_mode(0x0000_0001 | FILE_SHARE_DELETE)
        .open(&temporary)
        .map_err(|error| projection_path_error(&temporary, error))?;
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(10, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        file.write_all(&bytes[..bytes.len().min(8)])
            .map_err(projection_error)?;
        file.sync_all().map_err(projection_error)?;
        root_handle.sync_all().map_err(projection_error)?;
        return Err(projection_error("simulated deletion manifest write crash"));
    }
    file.write_all(&bytes).map_err(projection_error)?;
    file.sync_all().map_err(projection_error)?;
    rename_windows_handle(&file, &prepared, Some(root_handle))?;
    root_handle.sync_all().map_err(projection_error)?;
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(9, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return Err(projection_error(
            "simulated prepared deletion manifest crash",
        ));
    }
    rename_windows_handle(&file, &committed, Some(root_handle))?;
    root_handle.sync_all().map_err(projection_error)?;
    Ok(entries)
}

#[cfg(windows)]
fn remove_windows_claimed_tree_replayable(
    root: &Path,
    root_handle: File,
    root_identity: &str,
    content_digest: &str,
) -> Result<()> {
    let entries = load_or_publish_windows_tree_deletion_manifest(
        root,
        &root_handle,
        root_identity,
        content_digest,
    )?;
    for entry in entries {
        let path = root.join(Path::new(&entry.path));
        let Some(node) = open_windows_exclusive_delete_node_if_exists(&path)? else {
            continue;
        };
        require_windows_identity(
            &node,
            &entry.identity,
            "projection child identity changed during removal",
        )?;
        if !entry.directory
            && windows_open_file_content_digest(&node)? != *entry.content_digest.as_ref().unwrap()
        {
            return Err(projection_error(
                "projection child content changed during removal",
            ));
        }
        delete_windows_handle(node, entry.directory)?;
        root_handle.sync_all().map_err(projection_error)?;
    }
    let (committed, _prepared) = windows_tree_deletion_manifest_paths(root);
    let remaining: Vec<String> = enumerate_windows_children(&root_handle)?
        .into_iter()
        .map(|(name, _id, _attributes)| name)
        .filter(|name| name != ".gsd-delete-manifest" && name != ".gsd-delete-manifest.prepared")
        .collect();
    if !remaining.is_empty() {
        return Err(projection_error(
            "projection deletion retained unexpected occupants",
        ));
    }
    if let Some(manifest) = open_windows_delete_node_if_exists(&committed)? {
        delete_windows_handle(manifest, false)?;
        root_handle.sync_all().map_err(projection_error)?;
    }
    delete_windows_handle(root_handle, true)
}

#[cfg(windows)]
fn encode_windows_control_intent(
    target_name: &str,
    temporary_name: &str,
    replaced_name: &str,
    later_evidence_name: &str,
    old_identity: &str,
    new_identity: &str,
    phase: &str,
    content: &[u8],
) -> Result<Vec<u8>> {
    encode_windows_control_intent_record(&WindowsControlIntent {
        sequence: 1,
        target_name: target_name.to_owned(),
        temporary_name: temporary_name.to_owned(),
        replaced_name: replaced_name.to_owned(),
        later_evidence_name: later_evidence_name.to_owned(),
        old_identity: old_identity.to_owned(),
        new_identity: new_identity.to_owned(),
        content_length: content.len() as u64,
        content_digest: control_content_digest(content),
        phase: phase.to_owned(),
        target_evidence: "pending".to_owned(),
        temporary_evidence: "pending".to_owned(),
        replacement_evidence: "pending".to_owned(),
    })
}

#[cfg(windows)]
fn encode_windows_control_intent_record(record: &WindowsControlIntent) -> Result<Vec<u8>> {
    let payload = serde_json::json!({
        "contentDigest": record.content_digest,
        "contentLength": record.content_length,
        "laterEvidenceName": record.later_evidence_name,
        "newIdentity": record.new_identity,
        "oldIdentity": record.old_identity,
        "phase": record.phase,
        "targetEvidence": record.target_evidence,
        "temporaryEvidence": record.temporary_evidence,
        "replacementEvidence": record.replacement_evidence,
        "sequence": record.sequence,
        "replacedName": record.replaced_name,
        "targetName": record.target_name,
        "temporaryName": record.temporary_name,
        "version": 4,
    });
    let payload_bytes = serde_json::to_vec(&payload).map_err(projection_error)?;
    serde_json::to_vec(&serde_json::json!({
        "checksum": control_content_digest(&payload_bytes),
        "payload": payload,
    }))
    .map_err(projection_error)
}

#[cfg(windows)]
fn decode_windows_control_intent(bytes: &[u8]) -> Result<WindowsControlIntent> {
    let wrapper: serde_json::Value = serde_json::from_slice(bytes).map_err(projection_error)?;
    let payload = wrapper
        .get("payload")
        .ok_or_else(|| projection_error("control publication payload is missing"))?;
    let checksum = wrapper
        .get("checksum")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| projection_error("control publication checksum is missing"))?;
    let payload_bytes = serde_json::to_vec(payload).map_err(projection_error)?;
    if checksum != control_content_digest(&payload_bytes) {
        return Err(projection_error(
            "control publication evidence checksum changed",
        ));
    }
    if payload.get("version").and_then(serde_json::Value::as_u64) != Some(4) {
        return Err(projection_error(
            "control publication evidence version is invalid",
        ));
    }
    let string = |name: &str| {
        payload
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| projection_error("control publication evidence is incomplete"))
    };
    let phase = string("phase")?;
    if phase != "prepared" && phase != "temporary-durable" && phase != "evidence-retaining" {
        return Err(projection_error("control publication phase is invalid"));
    }
    let evidence_state = |name: &str| -> Result<String> {
        let state = string(name)?;
        if !matches!(
            state.as_str(),
            "pending" | "required" | "absent" | "retained"
        ) {
            return Err(projection_error(
                "control publication evidence state is invalid",
            ));
        }
        Ok(state)
    };
    Ok(WindowsControlIntent {
        sequence: payload
            .get("sequence")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| projection_error("control publication sequence is missing"))?,
        target_name: string("targetName")?,
        temporary_name: string("temporaryName")?,
        replaced_name: string("replacedName")?,
        later_evidence_name: string("laterEvidenceName")?,
        old_identity: string("oldIdentity")?,
        new_identity: string("newIdentity")?,
        content_length: payload
            .get("contentLength")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| projection_error("control publication length is missing"))?,
        content_digest: string("contentDigest")?,
        phase,
        target_evidence: evidence_state("targetEvidence")?,
        temporary_evidence: evidence_state("temporaryEvidence")?,
        replacement_evidence: evidence_state("replacementEvidence")?,
    })
}

#[cfg(windows)]
fn windows_file_matches_content(file: &File, intent: &WindowsControlIntent) -> Result<bool> {
    let mut reader = file.try_clone().map_err(projection_error)?;
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(projection_error)?;
    Ok(bytes.len() as u64 == intent.content_length
        && control_content_digest(&bytes) == intent.content_digest)
}

#[cfg(windows)]
fn begin_windows_evidence_retention(
    current: File,
    intent_path: &Path,
    prepared_intent_path: &Path,
    recorded: &mut WindowsControlIntent,
    guards: &[File],
    root: Option<&File>,
) -> Result<File> {
    if recorded.phase == "evidence-retaining" {
        return Ok(current);
    }
    recorded.phase = "evidence-retaining".to_owned();
    replace_windows_control_intent(
        current,
        intent_path,
        prepared_intent_path,
        recorded,
        guards,
        root,
    )
}

#[cfg(windows)]
fn replace_windows_control_intent(
    current: File,
    intent_path: &Path,
    prepared_intent_path: &Path,
    recorded: &mut WindowsControlIntent,
    guards: &[File],
    root: Option<&File>,
) -> Result<File> {
    recorded.sequence = recorded
        .sequence
        .checked_add(1)
        .ok_or_else(|| projection_error("control publication sequence overflow"))?;
    let bytes = encode_windows_control_intent_record(recorded)?;
    let successor =
        write_windows_control_intent(prepared_intent_path, &bytes, guards.last().or(root))?;
    delete_windows_handle(current, false)?;
    sync_windows_parent(guards, root)?;
    rename_windows_handle(&successor, intent_path, guards.last().or(root))?;
    // Release the DELETE-access rename handle before reopening the intent path;
    // `open_windows_delete_node` uses non-share-delete access and would
    // otherwise hit ERROR_SHARING_VIOLATION (os error 32) against this handle.
    drop(successor);
    sync_windows_parent(guards, root)?;
    open_windows_delete_node(intent_path)
}

#[cfg(windows)]
fn windows_evidence_state_mut<'a>(
    recorded: &'a mut WindowsControlIntent,
    participant: &str,
) -> Result<&'a mut String> {
    match participant {
        "target" => Ok(&mut recorded.target_evidence),
        "temporary" => Ok(&mut recorded.temporary_evidence),
        "replacement" => Ok(&mut recorded.replacement_evidence),
        _ => Err(projection_error(
            "control publication participant is invalid",
        )),
    }
}

#[cfg(windows)]
fn retain_windows_control_participant(
    mut intent: File,
    intent_path: &Path,
    prepared_intent_path: &Path,
    recorded: &mut WindowsControlIntent,
    participant: &str,
    file: Option<File>,
    source_path: &Path,
    logical_target: &Path,
    reason: &str,
    guards: &[File],
    root: Option<&File>,
    root_path: &Path,
) -> Result<File> {
    let has_evidence = windows_source_has_public_evidence(root_path, source_path)?;
    if windows_evidence_state_mut(recorded, participant)?.as_str() == "pending" {
        *windows_evidence_state_mut(recorded, participant)? = if file.is_some() || has_evidence {
            "required".to_owned()
        } else {
            "absent".to_owned()
        };
        intent = replace_windows_control_intent(
            intent,
            intent_path,
            prepared_intent_path,
            recorded,
            guards,
            root,
        )?;
    }
    match windows_evidence_state_mut(recorded, participant)?.as_str() {
        "absent" if file.is_none() && !has_evidence => return Ok(intent),
        "absent" => {
            return Err(projection_error(
                "control publication participant state changed",
            ))
        }
        "retained" if has_evidence => return Ok(intent),
        "retained" => {
            return Err(projection_error(
                "control publication evidence retention is incomplete",
            ))
        }
        "required" => {}
        _ => {
            return Err(projection_error(
                "control publication participant state is invalid",
            ))
        }
    }
    if let Some(file) = file {
        retain_open_windows_file_as_evidence(
            file,
            source_path,
            logical_target,
            reason,
            guards,
            root,
            Some(root_path),
        )?;
    }
    if !windows_source_has_public_evidence(root_path, source_path)? {
        return Err(projection_error(
            "control publication evidence retention is incomplete",
        ));
    }
    *windows_evidence_state_mut(recorded, participant)? = "retained".to_owned();
    replace_windows_control_intent(
        intent,
        intent_path,
        prepared_intent_path,
        recorded,
        guards,
        root,
    )
}

#[cfg(windows)]
fn recover_windows_control_directory(
    path: &Path,
    directory: Option<&File>,
    guards: &[File],
    root: Option<&File>,
    root_path: Option<&Path>,
) -> Result<()> {
    let mut names: Vec<String> = match directory {
        Some(handle) => enumerate_windows_children(handle)?
            .into_iter()
            .map(|(name, _, _)| name)
            .collect(),
        None => {
            let entries = match fs::read_dir(path) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(projection_path_error(path, error)),
            };
            let mut names = Vec::new();
            for entry in entries {
                names.push(
                    entry
                        .map_err(|error| projection_path_error(path, error))?
                        .file_name()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            names
        }
    };
    let mut targets = std::collections::BTreeSet::new();
    for name in names.drain(..) {
        let Some(control) = name.strip_prefix(".gsd-control-") else {
            continue;
        };
        if let Some(target) = control.strip_suffix(".intent.prepared") {
            targets.insert(target.to_owned());
        } else if let Some(target) = control.strip_suffix(".intent") {
            targets.insert(target.to_owned());
        }
    }
    for target_name in targets {
        recover_windows_control_publication(
            &path.join(&target_name),
            &path.join(format!(".gsd-control-{target_name}.temporary")),
            &path.join(format!(".gsd-control-{target_name}.replaced")),
            &path.join(format!(".gsd-control-{target_name}.intent")),
            &path.join(format!(".gsd-control-{target_name}.intent.prepared")),
            guards,
            root,
            root_path,
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn windows_evidence_state_progress(current: &str, successor: &str) -> bool {
    current == successor
        || current == "pending" && matches!(successor, "required" | "absent")
        || current == "required" && successor == "retained"
}

#[cfg(windows)]
fn recover_windows_control_publication(
    target: &Path,
    temporary: &Path,
    replaced: &Path,
    intent_path: &Path,
    prepared_intent_path: &Path,
    guards: &[File],
    root: Option<&File>,
    root_path: Option<&Path>,
) -> Result<()> {
    if let Some(prepared) = open_windows_delete_node_if_exists(prepared_intent_path)? {
        let mut reader = prepared.try_clone().map_err(projection_error)?;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).map_err(projection_error)?;
        let prepared_record = decode_windows_control_intent(&bytes);
        if prepared_record.is_err() {
            drop(reader);
            retain_windows_public_evidence(
                prepared,
                prepared_intent_path,
                target,
                &bytes,
                "malformed-prepared-intent",
                guards,
                root,
                root_path,
            )?;
        } else {
            if let Some(current) = open_windows_delete_node_if_exists(intent_path)? {
                let mut current_reader = current.try_clone().map_err(projection_error)?;
                let mut current_bytes = Vec::new();
                current_reader
                    .read_to_end(&mut current_bytes)
                    .map_err(projection_error)?;
                let current_record = decode_windows_control_intent(&current_bytes)?;
                let prepared_record = prepared_record.as_ref().unwrap();
                let phase_progress = current_record.phase == prepared_record.phase
                    || current_record.phase == "prepared"
                        && prepared_record.phase == "temporary-durable"
                    || current_record.phase == "prepared"
                        && prepared_record.phase == "evidence-retaining"
                    || current_record.phase == "temporary-durable"
                        && prepared_record.phase == "evidence-retaining";
                if prepared_record.sequence != current_record.sequence + 1
                    || current_record.target_name != prepared_record.target_name
                    || current_record.temporary_name != prepared_record.temporary_name
                    || current_record.replaced_name != prepared_record.replaced_name
                    || current_record.later_evidence_name != prepared_record.later_evidence_name
                    || current_record.content_length != prepared_record.content_length
                    || current_record.content_digest != prepared_record.content_digest
                    || current_record.old_identity != prepared_record.old_identity
                    || current_record.new_identity != prepared_record.new_identity
                    || !phase_progress
                    || !windows_evidence_state_progress(
                        &current_record.target_evidence,
                        &prepared_record.target_evidence,
                    )
                    || !windows_evidence_state_progress(
                        &current_record.temporary_evidence,
                        &prepared_record.temporary_evidence,
                    )
                    || !windows_evidence_state_progress(
                        &current_record.replacement_evidence,
                        &prepared_record.replacement_evidence,
                    )
                {
                    return Err(projection_error("control publication intents conflict"));
                }
                drop(current_reader);
                delete_windows_handle(current, false)?;
                sync_windows_parent(guards, root)?;
            }
            rename_windows_handle(&prepared, intent_path, guards.last().or(root))?;
            sync_windows_parent(guards, root)?;
        }
    }
    let Some(mut intent) = open_windows_delete_node_if_exists(intent_path)? else {
        return Ok(());
    };
    let mut intent_reader = intent.try_clone().map_err(projection_error)?;
    let mut evidence = Vec::new();
    intent_reader
        .read_to_end(&mut evidence)
        .map_err(projection_error)?;
    let mut recorded = decode_windows_control_intent(&evidence)?;
    drop(intent_reader);
    if target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .as_deref()
        != Some(recorded.target_name.as_str())
    {
        return Err(projection_error(
            "control publication target evidence changed",
        ));
    }
    let exact_name = |path: &Path, expected: &str| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .as_deref()
            == Some(expected)
    };
    if !exact_name(temporary, &recorded.temporary_name)
        || !exact_name(replaced, &recorded.replaced_name)
        || recorded.later_evidence_name
            != format!(".gsd-control-{}.later-evidence", recorded.target_name)
    {
        return Err(projection_error(
            "control publication path evidence changed",
        ));
    }
    let later_evidence = target.with_file_name(&recorded.later_evidence_name);
    let old_identity = recorded.old_identity.as_str();
    let mut target_file = open_windows_delete_node_if_exists(target)?;
    let temporary_file = open_windows_delete_node_if_exists(temporary)?;
    let replaced_file = open_windows_delete_node_if_exists(replaced)?;
    let target_is_old = if old_identity == "-" {
        target_file.is_none()
    } else {
        target_file
            .as_ref()
            .is_some_and(|file| windows_identity_string(file).ok().as_deref() == Some(old_identity))
    };
    if temporary_file.is_none() && replaced_file.is_none() && target_is_old {
        delete_windows_handle(intent, false)?;
        return sync_windows_parent(guards, root);
    }
    let retain_participants = recorded.phase == "evidence-retaining"
        || target_file.as_ref().is_some_and(|file| {
            windows_identity_string(file).ok().as_deref() != Some(old_identity)
                && !windows_file_matches_content(file, &recorded).unwrap_or(false)
        });
    if retain_participants {
        let root_path =
            root_path.ok_or_else(|| projection_error("projection root path is closed"))?;
        intent = begin_windows_evidence_retention(
            intent,
            intent_path,
            prepared_intent_path,
            &mut recorded,
            guards,
            root,
        )?;
        intent = retain_windows_control_participant(
            intent,
            intent_path,
            prepared_intent_path,
            &mut recorded,
            "target",
            target_file.take(),
            target,
            target,
            "later-control-target",
            guards,
            root,
            root_path,
        )?;
        intent = retain_windows_control_participant(
            intent,
            intent_path,
            prepared_intent_path,
            &mut recorded,
            "temporary",
            temporary_file,
            temporary,
            target,
            "interrupted-control-temporary",
            guards,
            root,
            root_path,
        )?;
        intent = retain_windows_control_participant(
            intent,
            intent_path,
            prepared_intent_path,
            &mut recorded,
            "replacement",
            replaced_file,
            replaced,
            target,
            "interrupted-control-replacement",
            guards,
            root,
            root_path,
        )?;
        if [
            &recorded.target_evidence,
            &recorded.temporary_evidence,
            &recorded.replacement_evidence,
        ]
        .iter()
        .any(|state| !matches!(state.as_str(), "absent" | "retained"))
        {
            return Err(projection_error(
                "control publication evidence retention is incomplete",
            ));
        }
        delete_windows_handle(intent, false)?;
        return sync_windows_parent(guards, root);
    }
    if target_file.is_none() && temporary_file.is_none() {
        if let Some(replaced_file) = replaced_file {
            retain_open_windows_file_as_evidence(
                replaced_file,
                replaced,
                target,
                "interrupted-control-replacement",
                guards,
                root,
                root_path,
            )?;
        }
        let root_path =
            root_path.ok_or_else(|| projection_error("projection root path is closed"))?;
        if windows_source_has_public_evidence(root_path, target)?
            && windows_source_has_public_evidence(root_path, temporary)?
        {
            delete_windows_handle(intent, false)?;
            return sync_windows_parent(guards, root);
        }
        return Err(projection_error(
            "control publication evidence retention is incomplete",
        ));
    }
    let candidate = temporary_file.as_ref().or(target_file.as_ref());
    if candidate.is_some_and(|file| !windows_file_matches_content(file, &recorded).unwrap_or(false))
    {
        if target_is_old && replaced_file.is_none() {
            if let Some(temporary_file) = temporary_file {
                delete_windows_handle(temporary_file, false)?;
            }
            delete_windows_handle(intent, false)?;
            return sync_windows_parent(guards, root);
        }
        return Err(projection_error(
            "control publication content evidence changed",
        ));
    }
    let new_identity = candidate
        .map(windows_identity_string)
        .transpose()?
        .ok_or_else(|| projection_error("control publication temporary is missing"))?;
    if recorded.new_identity != "-" && recorded.new_identity != new_identity {
        return Err(projection_error(
            "control publication temporary identity changed",
        ));
    }
    if target_file.as_ref().is_some_and(|file| {
        windows_identity_string(file).ok().as_deref() == Some(new_identity.as_str())
    }) {
        if let Some(replaced_file) = replaced_file {
            require_windows_identity(
                &replaced_file,
                old_identity,
                "control replacement identity changed",
            )?;
            delete_windows_handle(replaced_file, false)?;
        }
        if let Some(temporary_file) = temporary_file {
            require_windows_identity(
                &temporary_file,
                &new_identity,
                "control temporary identity changed",
            )?;
            delete_windows_handle(temporary_file, false)?;
        }
    } else {
        let temporary_file = temporary_file
            .ok_or_else(|| projection_error("control temporary evidence is missing"))?;
        require_windows_identity(
            &temporary_file,
            &new_identity,
            "control temporary identity changed",
        )?;
        if let Some(target_file) = target_file {
            let target_identity = windows_identity_string(&target_file)?;
            if target_identity != old_identity {
                let mut reader = target_file.try_clone().map_err(projection_error)?;
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes).map_err(projection_error)?;
                drop(reader);
                retain_windows_public_evidence(
                    target_file,
                    target,
                    target,
                    &bytes,
                    "later-control-target",
                    guards,
                    root,
                    root_path,
                )?;
            } else {
                require_windows_identity(
                    &target_file,
                    old_identity,
                    "control target identity changed",
                )?;
                if replaced_file.is_some() {
                    return Err(projection_error("control replacement evidence conflicts"));
                }
                rename_windows_handle(&target_file, replaced, guards.last().or(root))?;
                sync_windows_parent(guards, root)?;
            }
        }
        rename_windows_handle(&temporary_file, target, guards.last().or(root))?;
        sync_windows_parent(guards, root)?;
        if let Some(replaced_file) = open_windows_delete_node_if_exists(replaced)? {
            require_windows_identity(
                &replaced_file,
                old_identity,
                "control replacement identity changed",
            )?;
            delete_windows_handle(replaced_file, false)?;
        }
    }
    delete_windows_handle(intent, false)?;
    sync_windows_parent(guards, root)
}

#[cfg(windows)]
fn windows_source_has_public_evidence(root: &Path, source: &Path) -> Result<bool> {
    let source = source
        .strip_prefix(root)
        .map_err(projection_error)?
        .to_string_lossy()
        .replace('\\', "/");
    let directory = root.join("migration/native-projection-evidence");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(projection_path_error(&directory, error)),
    };
    for entry in entries {
        let path = entry
            .map_err(|error| projection_path_error(&directory, error))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let token = path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| projection_error("native projection evidence descriptor is invalid"))?;
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(&path).map_err(|error| projection_path_error(&path, error))?,
        )
        .map_err(projection_error)?;
        let field = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| projection_error("native projection evidence descriptor is invalid"))
        };
        let sequence = value
            .get("sequence")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| projection_error("native projection evidence descriptor is invalid"))?;
        let evidence = field("evidencePath")?;
        let recorded_source = field("sourcePath")?;
        let identity = field("evidenceIdentity")?;
        let logical = field("logicalPath")?;
        let digest = field("contentDigest")?;
        let reason = field("reason")?;
        let binding = windows_native_evidence_binding(
            sequence,
            field("phase")?,
            evidence,
            recorded_source,
            identity,
            logical,
            digest,
            reason,
        );
        let checksum = format!(
            "sha256:{:x}",
            Sha256::digest(format!("native-evidence-checksum\0{token}\0{binding}").as_bytes())
        );
        if value.get("version").and_then(serde_json::Value::as_u64) != Some(2)
            || field("token")? != token
            || windows_native_evidence_token(
                sequence,
                identity,
                recorded_source,
                logical,
                digest,
                reason,
            ) != token
            || field("phase")? != "retained"
            || field("kind")? != "quarantine"
            || field("scope")? != "file"
            || field("checksum")? != checksum
        {
            return Err(projection_error(
                "native projection evidence descriptor is invalid",
            ));
        }
        let (evidence_relative, _, _) = validate_windows_native_evidence_paths(
            token,
            evidence,
            recorded_source,
            logical,
            reason,
        )?;
        if recorded_source == source {
            let evidence_path = root.join(&evidence_relative);
            let file = open_windows_exclusive_delete_node(&evidence_path)?;
            require_windows_identity(
                &file,
                identity,
                "native projection evidence identity changed",
            )?;
            if windows_open_file_content_digest(&file)? != digest {
                return Err(projection_error(
                    "native projection evidence content changed",
                ));
            }
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(windows)]
fn retain_windows_public_evidence(
    source: File,
    source_path: &Path,
    logical_target: &Path,
    content: &[u8],
    reason: &str,
    guards: &[File],
    root: Option<&File>,
    root_path: Option<&Path>,
) -> Result<()> {
    let root_path = root_path.ok_or_else(|| projection_error("projection root path is closed"))?;
    let logical_path = logical_target
        .strip_prefix(root_path)
        .map_err(projection_error)?
        .to_string_lossy()
        .replace('\\', "/");
    let source_relative = source_path
        .strip_prefix(root_path)
        .map_err(projection_error)?
        .to_string_lossy()
        .replace('\\', "/");
    let digest = control_content_digest(content);
    let evidence_identity = windows_identity_string(&source)?;
    let sequence = 1u64;
    let token = windows_native_evidence_token(
        sequence,
        &evidence_identity,
        &source_relative,
        &logical_path,
        &digest,
        reason,
    );
    let evidence_path = source_path.with_file_name(format!(".gsd-projection-remove-{token}"));
    let relative_evidence = evidence_path
        .strip_prefix(root_path)
        .map_err(projection_error)?
        .to_string_lossy()
        .replace('\\', "/");
    validate_windows_native_evidence_paths(
        &token,
        &relative_evidence,
        &source_relative,
        &logical_path,
        reason,
    )?;
    let descriptor_directory = root_path.join("migration/native-projection-evidence");
    let mut directory = root_path.to_path_buf();
    for component in ["migration", "native-projection-evidence"] {
        directory.push(component);
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(projection_path_error(&directory, error)),
        }
        reject_windows_reparse(&directory)?;
        open_windows_directory(&directory)?
            .sync_all()
            .map_err(projection_error)?;
    }
    let retained_binding = windows_native_evidence_binding(
        sequence,
        "retained",
        &relative_evidence,
        &source_relative,
        &evidence_identity,
        &logical_path,
        &digest,
        reason,
    );
    let descriptor = windows_native_evidence_descriptor(
        sequence,
        "retained",
        &token,
        &retained_binding,
        &relative_evidence,
        &source_relative,
        &evidence_identity,
        &logical_path,
        &digest,
        reason,
    )?;
    let prepared_binding = windows_native_evidence_binding(
        sequence,
        "prepared",
        &relative_evidence,
        &source_relative,
        &evidence_identity,
        &logical_path,
        &digest,
        reason,
    );
    let prepared_descriptor = windows_native_evidence_descriptor(
        sequence,
        "prepared",
        &token,
        &prepared_binding,
        &relative_evidence,
        &source_relative,
        &evidence_identity,
        &logical_path,
        &digest,
        reason,
    )?;
    let descriptor_path = descriptor_directory.join(format!("{token}.json"));
    let prepared_path = descriptor_directory.join(format!(".{token}.prepared"));
    if descriptor_path.exists() {
        let existing = fs::read(&descriptor_path)
            .map_err(|error| projection_path_error(&descriptor_path, error))?;
        if existing != descriptor || !evidence_path.exists() {
            return Err(projection_error(
                "native projection evidence descriptor conflicts",
            ));
        }
        return Ok(());
    }
    if prepared_path.exists() {
        let existing = fs::read(&prepared_path)
            .map_err(|error| projection_path_error(&prepared_path, error))?;
        if existing != prepared_descriptor && existing != descriptor {
            return Err(projection_error(
                "native projection evidence descriptor conflicts",
            ));
        }
        if !evidence_path.exists() {
            rename_windows_handle(&source, &evidence_path, guards.last().or(root))?;
            sync_windows_parent(guards, root)?;
        }
        let prepared = open_windows_delete_node(&prepared_path)?;
        return publish_windows_retained_descriptor(
            &descriptor_directory,
            &token,
            &descriptor,
            Some(prepared),
        );
    }
    if open_windows_delete_node_if_exists(&evidence_path)?.is_some() {
        return Err(projection_error(
            "native projection evidence path conflicts",
        ));
    }
    let prepared =
        write_windows_control_intent(&prepared_path, &prepared_descriptor, guards.last().or(root))?;
    rename_windows_handle(&source, &evidence_path, guards.last().or(root))?;
    sync_windows_parent(guards, root)?;
    publish_windows_retained_descriptor(&descriptor_directory, &token, &descriptor, Some(prepared))
}

#[cfg(windows)]
fn publish_windows_retained_descriptor(
    directory: &Path,
    token: &str,
    descriptor: &[u8],
    previous: Option<File>,
) -> Result<()> {
    let successor_path = directory.join(format!(".{token}.retained.prepared"));
    let current_path = directory.join(format!("{token}.json"));
    let directory_handle = open_windows_directory(directory)?;
    let successor = if successor_path.exists() {
        if fs::read(&successor_path)
            .map_err(|error| projection_path_error(&successor_path, error))?
            != descriptor
        {
            return Err(projection_error(
                "native projection evidence descriptor conflicts",
            ));
        }
        open_windows_delete_node(&successor_path)?
    } else {
        write_windows_control_intent(&successor_path, descriptor, Some(&directory_handle))?
    };
    directory_handle.sync_all().map_err(projection_error)?;
    if current_path.exists() {
        if fs::read(&current_path).map_err(|error| projection_path_error(&current_path, error))?
            != descriptor
        {
            return Err(projection_error(
                "native projection evidence descriptor conflicts",
            ));
        }
        delete_windows_handle(successor, false)?;
    } else {
        rename_windows_handle(&successor, &current_path, Some(&directory_handle))?;
    }
    directory_handle.sync_all().map_err(projection_error)?;
    if let Some(previous) = previous {
        delete_windows_handle(previous, false)?;
        directory_handle.sync_all().map_err(projection_error)?;
    }
    Ok(())
}

#[cfg(windows)]
fn retain_open_windows_file_as_evidence(
    file: File,
    source_path: &Path,
    logical_target: &Path,
    reason: &str,
    guards: &[File],
    root: Option<&File>,
    root_path: Option<&Path>,
) -> Result<()> {
    let mut reader = file.try_clone().map_err(projection_error)?;
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(projection_error)?;
    drop(reader);
    retain_windows_public_evidence(
        file,
        source_path,
        logical_target,
        &bytes,
        reason,
        guards,
        root,
        root_path,
    )
}

#[cfg(windows)]
fn windows_native_evidence_binding(
    sequence: u64,
    phase: &str,
    evidence_path: &str,
    source_path: &str,
    evidence_identity: &str,
    logical_path: &str,
    content_digest: &str,
    reason: &str,
) -> String {
    [
        "2".to_owned(),
        sequence.to_string(),
        phase.to_owned(),
        "quarantine".to_owned(),
        "file".to_owned(),
        evidence_path.to_owned(),
        source_path.to_owned(),
        evidence_identity.to_owned(),
        logical_path.to_owned(),
        content_digest.to_owned(),
        reason.to_owned(),
    ]
    .join("\0")
}

#[cfg(windows)]
fn windows_native_evidence_token_binding(
    sequence: u64,
    evidence_identity: &str,
    source_path: &str,
    logical_path: &str,
    content_digest: &str,
    reason: &str,
) -> String {
    [
        "2".to_owned(),
        sequence.to_string(),
        "quarantine".to_owned(),
        "file".to_owned(),
        evidence_identity.to_owned(),
        source_path.to_owned(),
        logical_path.to_owned(),
        content_digest.to_owned(),
        reason.to_owned(),
    ]
    .join("\0")
}

#[cfg(windows)]
fn windows_native_evidence_token(
    sequence: u64,
    evidence_identity: &str,
    source_path: &str,
    logical_path: &str,
    content_digest: &str,
    reason: &str,
) -> String {
    let binding = windows_native_evidence_token_binding(
        sequence,
        evidence_identity,
        source_path,
        logical_path,
        content_digest,
        reason,
    );
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("native-evidence\0{binding}").as_bytes())
    );
    format!(
        "{}-{}-{}-{}-{}",
        &hash[0..8],
        &hash[8..12],
        &hash[12..16],
        &hash[16..20],
        &hash[20..32]
    )
}

#[cfg(windows)]
fn validate_windows_native_evidence_paths(
    token: &str,
    evidence_path: &str,
    source_path: &str,
    logical_path: &str,
    reason: &str,
) -> Result<(PathBuf, PathBuf, PathBuf)> {
    let safe_relative = |relative: &str| -> Result<PathBuf> {
        let path = Path::new(relative);
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(projection_error(
                "native projection evidence path is invalid",
            ));
        }
        Ok(path.to_path_buf())
    };
    let evidence = safe_relative(evidence_path)?;
    let source = safe_relative(source_path)?;
    let logical = safe_relative(logical_path)?;
    let logical_name = logical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| projection_error("native projection evidence path is invalid"))?;
    let expected_source = match reason {
        "later-control-target" => logical_name.to_owned(),
        "interrupted-control-temporary" => format!(".gsd-control-{logical_name}.temporary"),
        "interrupted-control-replacement" => format!(".gsd-control-{logical_name}.replaced"),
        "malformed-prepared-intent" => format!(".gsd-control-{logical_name}.intent.prepared"),
        _ => {
            return Err(projection_error(
                "native projection evidence path is invalid",
            ))
        }
    };
    let expected_evidence = format!(".gsd-projection-remove-{token}");
    if evidence.parent() != source.parent()
        || evidence.parent() != logical.parent()
        || evidence.file_name().and_then(|value| value.to_str()) != Some(expected_evidence.as_str())
        || source.file_name().and_then(|value| value.to_str()) != Some(expected_source.as_str())
    {
        return Err(projection_error(
            "native projection evidence path is invalid",
        ));
    }
    Ok((evidence, source, logical))
}

#[cfg(windows)]
fn windows_native_evidence_descriptor(
    sequence: u64,
    phase: &str,
    token: &str,
    binding: &str,
    evidence_path: &str,
    source_path: &str,
    evidence_identity: &str,
    logical_path: &str,
    content_digest: &str,
    reason: &str,
) -> Result<Vec<u8>> {
    let checksum = format!(
        "sha256:{:x}",
        Sha256::digest(format!("native-evidence-checksum\0{token}\0{binding}").as_bytes())
    );
    serde_json::to_vec(&serde_json::json!({
        "version": 2,
        "sequence": sequence,
        "token": token,
        "checksum": checksum,
        "phase": phase,
        "kind": "quarantine",
        "scope": "file",
        "evidencePath": evidence_path,
        "sourcePath": source_path,
        "evidenceIdentity": evidence_identity,
        "logicalPath": logical_path,
        "contentDigest": content_digest,
        "reason": reason,
    }))
    .map_err(projection_error)
}

#[cfg(windows)]
fn recover_windows_native_evidence_descriptors(root: &Path, root_handle: &File) -> Result<()> {
    let directory = root.join("migration/native-projection-evidence");
    if !directory.exists() {
        return Ok(());
    }
    reject_windows_reparse(&directory)?;
    let directory_handle = open_windows_directory(&directory)?;
    for entry in
        fs::read_dir(&directory).map_err(|error| projection_path_error(&directory, error))?
    {
        let entry = entry.map_err(|error| projection_path_error(&directory, error))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(prepared_name) = name.strip_prefix('.') else {
            continue;
        };
        let (token, retained_successor) =
            if let Some(token) = prepared_name.strip_suffix(".retained.prepared") {
                (token, true)
            } else if let Some(token) = prepared_name.strip_suffix(".prepared") {
                (token, false)
            } else {
                continue;
            };
        let prepared_path = entry.path();
        let value = serde_json::from_slice::<serde_json::Value>(
            &fs::read(&prepared_path)
                .map_err(|error| projection_path_error(&prepared_path, error))?,
        )
        .map_err(projection_error)?;
        let field = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| projection_error("native projection evidence descriptor is invalid"))
        };
        let sequence = value
            .get("sequence")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| projection_error("native projection evidence descriptor is invalid"))?;
        let phase = field("phase")?;
        let evidence_relative = field("evidencePath")?;
        let source_relative = field("sourcePath")?;
        let evidence_identity = field("evidenceIdentity")?;
        let logical_path = field("logicalPath")?;
        let content_digest = field("contentDigest")?;
        let reason = field("reason")?;
        if field("token")? != token
            || value.get("version").and_then(serde_json::Value::as_u64) != Some(2)
            || field("kind")? != "quarantine"
            || field("scope")? != "file"
            || (phase != "prepared" && phase != "retained")
            || retained_successor != (phase == "retained")
        {
            return Err(projection_error(
                "native projection evidence descriptor is invalid",
            ));
        }
        let binding = windows_native_evidence_binding(
            sequence,
            phase,
            evidence_relative,
            source_relative,
            evidence_identity,
            logical_path,
            content_digest,
            reason,
        );
        let checksum = format!(
            "sha256:{:x}",
            Sha256::digest(format!("native-evidence-checksum\0{token}\0{binding}").as_bytes())
        );
        if field("checksum")? != checksum {
            return Err(projection_error(
                "native projection evidence descriptor is invalid",
            ));
        }
        if windows_native_evidence_token(
            sequence,
            evidence_identity,
            source_relative,
            logical_path,
            content_digest,
            reason,
        ) != token
        {
            return Err(projection_error(
                "native projection evidence descriptor is invalid",
            ));
        }
        if retained_successor {
            let retained = fs::read(&prepared_path)
                .map_err(|error| projection_path_error(&prepared_path, error))?;
            let prepared = open_windows_delete_node(&prepared_path)?;
            let current_path = directory.join(format!("{token}.json"));
            if current_path.exists() {
                if fs::read(&current_path)
                    .map_err(|error| projection_path_error(&current_path, error))?
                    != retained
                {
                    return Err(projection_error(
                        "native projection evidence descriptor conflicts",
                    ));
                }
                delete_windows_handle(prepared, false)?;
            } else {
                rename_windows_handle(&prepared, &current_path, Some(&directory_handle))?;
            }
            directory_handle.sync_all().map_err(projection_error)?;
            continue;
        }
        let (evidence_relative_path, source_relative_path, _) =
            validate_windows_native_evidence_paths(
                token,
                evidence_relative,
                source_relative,
                logical_path,
                reason,
            )?;
        let evidence_path = root.join(evidence_relative_path);
        let source_path = root.join(source_relative_path);
        if !evidence_path.exists() {
            let source = open_windows_delete_node(&source_path)?;
            require_windows_identity(
                &source,
                evidence_identity,
                "native projection evidence source identity changed",
            )?;
            if control_content_digest(
                &fs::read(&source_path)
                    .map_err(|error| projection_path_error(&source_path, error))?,
            ) != content_digest
            {
                return Err(projection_error(
                    "native projection evidence source content changed",
                ));
            }
            // The evidence path is a sibling of the source. Rename relative to
            // the identity-held root handle there and open the parent directory
            // only when it is a subdirectory.
            let evidence_parent = evidence_path
                .parent()
                .ok_or_else(|| projection_error("native projection evidence path is invalid"))?;
            let opened_parent;
            let parent_handle = if evidence_parent == root {
                root_handle
            } else {
                opened_parent = open_windows_directory(evidence_parent)?;
                &opened_parent
            };
            rename_windows_handle(&source, &evidence_path, Some(parent_handle))?;
            parent_handle.sync_all().map_err(projection_error)?;
        }
        let retained_binding = windows_native_evidence_binding(
            sequence,
            "retained",
            evidence_relative,
            source_relative,
            evidence_identity,
            logical_path,
            content_digest,
            reason,
        );
        let retained = windows_native_evidence_descriptor(
            sequence,
            "retained",
            token,
            &retained_binding,
            evidence_relative,
            source_relative,
            evidence_identity,
            logical_path,
            content_digest,
            reason,
        )?;
        let prepared = open_windows_delete_node(&prepared_path)?;
        publish_windows_retained_descriptor(&directory, token, &retained, Some(prepared))?;
    }
    Ok(())
}

// Prepares the wide `FILE_RENAME_INFO` file name so that renames whose fully
// qualified target exceeds the legacy `MAX_PATH` limit do not fail with
// `ERROR_FILENAME_EXCED_RANGE` (os error 206). This mirrors the standard
// library's `get_long_path`: past the limit a plain drive-absolute path must
// carry the `\\?\` verbatim prefix. Short paths are returned byte-for-byte
// unchanged, and anything that is already verbatim/NT-prefixed, uses forward
// slashes, or is not a plain drive-absolute path is left exactly as-is (a
// verbatim prefix does not normalize `/` or `.`/`..`).
// Normalizes the projection root to a `\\?\` verbatim path so that every
// derived projection path (logical files, temporaries, guards, control intents,
// recovery-evidence claim trees) bypasses the legacy `MAX_PATH` limit on
// opens and creates (`ERROR_FILENAME_EXCED_RANGE` / os error 206). Deep test
// and recovery layouts exceed 260 characters even when the root itself is
// short, so the prefix is applied unconditionally rather than at a length
// threshold. Verbatim paths skip Win32 normalization (no separator folding, no
// `.`/`..` resolution, no trailing-space trimming), which is safe here because
// the root always comes from `realpathSync` (canonical, backslash-separated)
// and relative segments are validated by `projection_parts`. Drive-absolute
// and UNC roots are converted; anything already verbatim/NT-prefixed, device
// paths (`\\.\`), and non-absolute inputs are stored unchanged.
#[cfg(windows)]
fn windows_verbatim_root(path: String) -> PathBuf {
    const VERBATIM: &str = "\\\\?\\";
    const NT_PREFIX: &str = "\\??\\";
    const DEVICE_PREFIX: &str = "\\\\.\\";
    if path.starts_with(VERBATIM) || path.starts_with(NT_PREFIX) || path.starts_with(DEVICE_PREFIX)
    {
        return PathBuf::from(path);
    }
    let normalized = path.replace('/', "\\");
    if let Some(rest) = normalized.strip_prefix("\\\\") {
        return PathBuf::from(format!("{VERBATIM}UNC\\{rest}"));
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return PathBuf::from(format!("{VERBATIM}{normalized}"));
    }
    PathBuf::from(path)
}

// FILE_RENAME_INFO supports three target forms, and only one of them
// never re-parses a path: a simple file name with RootDirectory set to a
// handle of the target's parent directory. Full-path targets of every
// spelling (plain DOS, Win32 verbatim `\\?\`, NT-native `\??\`) make the
// I/O manager open the target's parent by path, which weakens correlation with
// the identity-held projection root and has produced ERROR_PATH_NOT_FOUND (3) /
// ERROR_INVALID_NAME (123) on CI, while a bare name
// with RootDirectory = NULL is resolved against the process current
// directory by the Win32 layer, landing renames in the wrong directory
// (observed as cross-project ERROR_ALREADY_EXISTS (183) collisions).
// Callers therefore pass the target's parent handle (the same handle they
// already sync); it is verified against the target path before use, and
// any mismatch falls back to the NT-native full-path form.
#[cfg(windows)]
fn windows_rename_target(parent: Option<&File>, raw: &[u16]) -> (Vec<u16>, Option<usize>) {
    const SEP: u16 = b'\\' as u16;
    const ALT_SEP: u16 = b'/' as u16;
    if let Some(directory) = parent {
        if let Some(separator) = raw.iter().rposition(|&unit| unit == SEP || unit == ALT_SEP) {
            if separator + 1 < raw.len() {
                if let Ok(handle_path) = windows_handle_path(directory) {
                    if windows_directory_key(&handle_path)
                        == windows_directory_key(&raw[..separator])
                    {
                        return (
                            raw[separator + 1..].to_vec(),
                            Some(directory.as_raw_handle() as usize),
                        );
                    }
                }
            }
        }
    }
    (windows_full_rename_target(raw), None)
}

// NT-native full-path fallback for rename targets whose parent directory
// handle is unavailable (cross-directory evidence moves). `\\?\` converts
// to `\??\` (`\\?\UNC\` to `\??\UNC\`), `\??\` passes through, and short
// plain DOS paths stay unchanged.
#[cfg(windows)]
fn windows_full_rename_target(raw: &[u16]) -> Vec<u16> {
    const LEGACY_MAX_PATH: usize = 248;
    const SEP: u16 = b'\\' as u16;
    const ALT_SEP: u16 = b'/' as u16;
    const QUERY: u16 = b'?' as u16;
    const COLON: u16 = b':' as u16;
    // \\?\
    const VERBATIM_PREFIX: [u16; 4] = [SEP, SEP, QUERY, SEP];
    // \??\
    const NT_PREFIX: [u16; 4] = [SEP, QUERY, QUERY, SEP];

    if raw.starts_with(&NT_PREFIX) {
        return raw.to_vec();
    }
    if raw.starts_with(&VERBATIM_PREFIX) {
        let mut converted = Vec::with_capacity(raw.len());
        converted.extend_from_slice(&NT_PREFIX);
        converted.extend_from_slice(&raw[VERBATIM_PREFIX.len()..]);
        return converted;
    }
    if raw.len() < LEGACY_MAX_PATH {
        return raw.to_vec();
    }
    if raw.iter().any(|&unit| unit == ALT_SEP) {
        return raw.to_vec();
    }
    match raw {
        [drive, COLON, SEP, ..] if *drive != SEP => {
            let mut prefixed = Vec::with_capacity(NT_PREFIX.len() + raw.len());
            prefixed.extend_from_slice(&NT_PREFIX);
            prefixed.extend_from_slice(raw);
            prefixed
        }
        _ => raw.to_vec(),
    }
}

/// Case- and separator-folded directory key for same-directory detection.
/// Strips `\\?\`/`\??\` prefixes and folds `\\?\UNC\` to the `\\` share
/// form so equivalent spellings of one directory compare equal.
#[cfg(windows)]
fn windows_directory_key(path: &[u16]) -> Vec<u16> {
    const SEP: u16 = b'\\' as u16;
    const ALT_SEP: u16 = b'/' as u16;
    const QUERY: u16 = b'?' as u16;
    let mut value: Vec<u16> = path.to_vec();
    if value.len() >= 4
        && value[0] == SEP
        && (value[1] == SEP || value[1] == QUERY)
        && value[2] == QUERY
        && value[3] == SEP
    {
        value.drain(..4);
        if value.len() >= 4
            && (value[0] | 0x20) == b'u' as u16
            && (value[1] | 0x20) == b'n' as u16
            && (value[2] | 0x20) == b'c' as u16
            && value[3] == SEP
        {
            value.drain(..4);
            value.insert(0, SEP);
            value.insert(0, SEP);
        }
    }
    for unit in value.iter_mut() {
        if *unit == ALT_SEP {
            *unit = SEP;
        } else if (b'A' as u16..=b'Z' as u16).contains(unit) {
            *unit += 32;
        }
    }
    while value.len() > 1 && value.last() == Some(&SEP) {
        value.pop();
    }
    value
}

#[cfg(windows)]
fn windows_handle_path(file: &File) -> Result<Vec<u16>> {
    const VOLUME_NAME_DOS: u32 = 0;
    let mut buffer = vec![0u16; 32 * 1024];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            VOLUME_NAME_DOS,
        )
    };
    if length == 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    if length as usize >= buffer.len() {
        return Err(projection_error(
            "projection rename handle path exceeds the query buffer",
        ));
    }
    buffer.truncate(length as usize);
    Ok(buffer)
}

#[cfg(windows)]
fn rename_windows_handle(file: &File, target: &Path, parent: Option<&File>) -> Result<()> {
    let source_units = windows_handle_path(file)?;
    let source = String::from_utf16_lossy(&source_units);
    let operation = format!(
        "renaming projection child from {source} to {}",
        target.display(),
    );
    let raw: Vec<u16> = target.as_os_str().encode_wide().collect();
    let (name, root_directory) = windows_rename_target(parent, &raw);
    let root_offset = (std::mem::size_of::<u32>() + std::mem::align_of::<usize>() - 1)
        & !(std::mem::align_of::<usize>() - 1);
    let length_offset = root_offset + std::mem::size_of::<usize>();
    let name_offset = length_offset + std::mem::size_of::<u32>();
    let mut information = vec![0u8; name_offset + name.len() * std::mem::size_of::<u16>()];
    if let Some(handle) = root_directory {
        information[root_offset..length_offset].copy_from_slice(&handle.to_ne_bytes());
    }
    information[length_offset..name_offset]
        .copy_from_slice(&((name.len() * std::mem::size_of::<u16>()) as u32).to_ne_bytes());
    for (index, value) in name.iter().enumerate() {
        let offset = name_offset + index * std::mem::size_of::<u16>();
        information[offset..offset + std::mem::size_of::<u16>()]
            .copy_from_slice(&value.to_ne_bytes());
    }
    retry_windows_projection_operation(
        &operation,
        || {
            let mut status_block = WindowsIoStatusBlock {
                status: 0,
                information: 0,
            };
            let status = unsafe {
                NtSetInformationFile(
                    file.as_raw_handle(),
                    &mut status_block,
                    information.as_mut_ptr().cast(),
                    information.len() as u32,
                    FILE_RENAME_INFORMATION_NT_CLASS,
                )
            };
            if status < 0 {
                let code = unsafe { RtlNtStatusToDosError(status) };
                return Err(std::io::Error::from_raw_os_error(code as i32));
            }
            Ok(())
        },
        |delay_ms| std::thread::sleep(std::time::Duration::from_millis(delay_ms)),
    )
}

#[cfg(windows)]
fn sync_windows_parent(guards: &[File], root: Option<&File>) -> Result<()> {
    match guards.last().or(root) {
        Some(parent) => parent.sync_all().map_err(projection_error),
        None => Err(Error::new(
            Status::GenericFailure,
            "projection root is closed".to_owned(),
        )),
    }
}

#[cfg(unix)]
fn temporary_name(target: &CString) -> CString {
    CString::new(format!(
        ".gsd-projection-tmp-{}-{}-{}",
        target.to_string_lossy(),
        std::process::id(),
        TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ))
    .unwrap()
}

#[cfg(unix)]
fn create_relative_file(parent: &File, name: &CString) -> Result<File> {
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn open_relative_node(parent: &File, name: &CString, directory: bool) -> Result<File> {
    let flags = libc::O_RDONLY
        | libc::O_NONBLOCK
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | if directory { libc::O_DIRECTORY } else { 0 };
    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if descriptor < 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    if file.metadata().map_err(projection_error)?.is_dir() != directory {
        return Err(projection_error(
            "projection root contains an unsupported node",
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn parse_unix_identity(identity: &str) -> Result<(u64, u64)> {
    let (device, inode) = identity
        .split_once(':')
        .ok_or_else(|| projection_error("projection identity is invalid"))?;
    Ok((
        device.parse().map_err(projection_error)?,
        inode.parse().map_err(projection_error)?,
    ))
}

#[cfg(unix)]
fn require_unix_identity(file: &File, expected: &str, message: &str) -> Result<()> {
    let metadata = file.metadata().map_err(projection_error)?;
    if (metadata.dev(), metadata.ino()) != parse_unix_identity(expected)? {
        return Err(projection_error(message));
    }
    Ok(())
}

#[cfg(unix)]
fn relative_identity(parent: &File, name: &CString) -> Result<Option<String>> {
    let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            current.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) {
            return Ok(None);
        }
        return Err(projection_error(error));
    }
    let current = unsafe { current.assume_init() };
    Ok(Some(format!("{}:{}", current.st_dev, current.st_ino)))
}

#[cfg(unix)]
fn relative_is_directory(parent: &File, name: &CString) -> Result<bool> {
    let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            current.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    Ok((unsafe { current.assume_init() }.st_mode & libc::S_IFMT) == libc::S_IFDIR)
}

#[cfg(unix)]
fn projection_content_digest_at(parent: &File, name: &CString, directory: bool) -> Result<String> {
    let node = open_relative_node(parent, name, directory)?;
    let mut hash = Sha256::new();
    if directory {
        hash_projection_tree(&node, "", &mut hash)?;
    } else {
        let mut reader = node;
        hash_open_file(&mut reader, &mut hash)?;
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

#[cfg(unix)]
fn inject_unix_mutation_boundary_fault(
    parent: &File,
    name: &CString,
    claimed: &File,
    directory: bool,
    publication: bool,
) -> Result<()> {
    let expected = if publication {
        3
    } else if directory {
        2
    } else {
        1
    };
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(expected, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }
    if directory {
        let name = CString::new(".gsd-final-boundary-fault").unwrap();
        let mut file = create_relative_file(claimed, &name)?;
        file.write_all(b"changed after proof\n")
            .map_err(projection_error)?;
        file.sync_all().map_err(projection_error)?;
        return claimed.sync_all().map_err(projection_error);
    }
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    file.write_all(b"changed after proof\n")
        .map_err(projection_error)?;
    file.sync_all().map_err(projection_error)
}

#[cfg(unix)]
fn hash_projection_tree(directory: &File, relative: &str, hash: &mut Sha256) -> Result<()> {
    hash.update(relative.as_bytes());
    hash.update(b"\0directory\0");
    let scan_descriptor = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if scan_descriptor < 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    if unsafe { libc::lseek(scan_descriptor, 0, libc::SEEK_SET) } < 0 {
        unsafe { libc::close(scan_descriptor) };
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let scan = unsafe { libc::fdopendir(scan_descriptor) };
    if scan.is_null() {
        unsafe { libc::close(scan_descriptor) };
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let mut entries = Vec::new();
    clear_directory_scan_error();
    loop {
        let entry = unsafe { libc::readdir(scan) };
        if entry.is_null() {
            if let Some(error) = directory_scan_error() {
                unsafe { libc::closedir(scan) };
                return Err(projection_error(error));
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            entries.push(CString::new(name.to_bytes()).map_err(projection_error)?);
        }
    }
    unsafe { libc::closedir(scan) };
    entries.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    for entry in entries {
        let entry_text = entry.to_string_lossy();
        let child_relative = if relative.is_empty() {
            entry_text.into_owned()
        } else {
            format!("{relative}/{entry_text}")
        };
        let child =
            open_relative_node(directory, &entry, relative_is_directory(directory, &entry)?)?;
        let metadata = child.metadata().map_err(projection_error)?;
        if metadata.is_dir() {
            hash_projection_tree(&child, &child_relative, hash)?;
        } else if metadata.is_file() {
            hash.update(child_relative.as_bytes());
            hash.update(b"\0file\0");
            let mut reader = child;
            hash_open_file(&mut reader, hash)?;
            hash.update(b"\0");
        } else {
            return Err(projection_error(
                "projection root contains an unsupported node",
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn hash_open_file(file: &mut File, hash: &mut Sha256) -> Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(projection_error)?;
        if read == 0 {
            return Ok(());
        }
        hash.update(&buffer[..read]);
    }
}

#[cfg(unix)]
fn relative_identity_matches(parent: &File, name: &CString, expected: &str) -> Result<bool> {
    Ok(relative_identity(parent, name)?.as_deref() == Some(expected))
}

#[cfg(unix)]
fn require_relative_identity(
    parent: &File,
    name: &CString,
    expected: &str,
    message: &str,
) -> Result<()> {
    if !relative_identity_matches(parent, name, expected)? {
        return Err(projection_error(message));
    }
    Ok(())
}

#[cfg(unix)]
fn rename_open_relative(
    parent: &File,
    source: &CString,
    target: &CString,
    file: &File,
) -> Result<()> {
    rename_open_relative_between(parent, source, parent, target, file)
}

#[cfg(unix)]
fn rename_open_relative_between(
    source_parent: &File,
    source: &CString,
    target_parent: &File,
    target: &CString,
    file: &File,
) -> Result<()> {
    let expected = file.metadata().map_err(projection_error)?;
    let expected_identity = format!("{}:{}", expected.dev(), expected.ino());
    require_relative_identity(
        source_parent,
        source,
        &expected_identity,
        "projection source identity changed",
    )?;
    rename_relative_between_exclusive(source_parent, source, target_parent, target)?;
    source_parent.sync_all().map_err(projection_error)?;
    target_parent.sync_all().map_err(projection_error)?;
    require_relative_identity(
        target_parent,
        target,
        &expected_identity,
        "projection source identity changed during publication",
    )
}

#[cfg(unix)]
fn tree_publication_claim_name(identity: &str, content_digest: &str, target: &CString) -> CString {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "tree-publication\0{identity}\0{content_digest}\0{}",
                target.to_string_lossy(),
            )
            .as_bytes(),
        )
    );
    CString::new(format!(".gsd-publication-claim-{}", &digest[..32])).unwrap()
}

#[cfg(unix)]
fn open_or_create_relative_directory(parent: &File, name: &CString) -> Result<File> {
    if relative_identity(parent, name)?.is_none() {
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
        parent.sync_all().map_err(projection_error)?;
    }
    open_relative_node(parent, name, true)
}

#[cfg(unix)]
fn recovery_evidence_directory(root: &File) -> Result<File> {
    let migration = open_or_create_relative_directory(root, &CString::new("migration").unwrap())?;
    open_or_create_relative_directory(&migration, &CString::new("recovery-evidence").unwrap())
}

#[cfg(unix)]
fn copy_projection_tree_resumable(
    source: &File,
    destination: &File,
    allow_fault: &mut bool,
) -> Result<()> {
    let source_names = directory_names(source)?;
    for name in directory_names(destination)? {
        if !source_names.contains(&name) {
            return Err(projection_error(
                "projection private snapshot retained unexpected occupants",
            ));
        }
    }
    for name in source_names {
        let directory = relative_is_directory(source, &name)?;
        let node = open_relative_node(source, &name, directory)?;
        let metadata = node.metadata().map_err(projection_error)?;
        if directory {
            let child = open_or_create_relative_directory(destination, &name)?;
            copy_projection_tree_resumable(&node, &child, allow_fault)?;
            child.sync_all().map_err(projection_error)?;
        } else if metadata.is_file() {
            if relative_identity(destination, &name)?.is_some()
                && projection_content_digest_at(source, &name, false)?
                    != projection_content_digest_at(destination, &name, false)?
            {
                remove_node_at(destination, &name, false, None)?;
            }
            if relative_identity(destination, &name)?.is_none() {
                let mut reader = node;
                let mut writer = create_relative_file(destination, &name)?;
                std::io::copy(&mut reader, &mut writer).map_err(projection_error)?;
                writer.sync_all().map_err(projection_error)?;
            }
        } else {
            return Err(projection_error(
                "projection root contains an unsupported node",
            ));
        }
        destination.sync_all().map_err(projection_error)?;
        if *allow_fault
            && MUTATION_BOUNDARY_FAULT
                .compare_exchange(18, 0, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            *allow_fault = false;
            return Err(projection_error("simulated private snapshot copy crash"));
        }
    }
    destination.sync_all().map_err(projection_error)
}

#[cfg(unix)]
fn publication_snapshot_record(
    source_identity: &str,
    snapshot_identity: &str,
    content_digest: &str,
    target: &CString,
) -> Result<Vec<u8>> {
    let target = target
        .to_str()
        .map_err(|_| projection_error("projection target is not valid UTF-8"))?;
    let payload = serde_json::json!({
        "version": 1,
        "sourceIdentity": source_identity,
        "snapshotIdentity": snapshot_identity,
        "contentDigest": content_digest,
        "target": target,
    });
    let payload_bytes = serde_json::to_vec(&payload).map_err(projection_error)?;
    serde_json::to_vec(&serde_json::json!({
        "checksum": format!("sha256:{:x}", Sha256::digest(&payload_bytes)),
        "payload": payload,
    }))
    .map_err(projection_error)
}

#[cfg(unix)]
fn decode_publication_snapshot_record(
    bytes: &[u8],
    source_identity: &str,
    content_digest: &str,
    target: &CString,
) -> Result<String> {
    let wrapper: serde_json::Value = serde_json::from_slice(bytes).map_err(projection_error)?;
    let payload = wrapper
        .get("payload")
        .ok_or_else(|| projection_error("projection publication record is invalid"))?;
    let payload_bytes = serde_json::to_vec(payload).map_err(projection_error)?;
    let target = target
        .to_str()
        .map_err(|_| projection_error("projection target is not valid UTF-8"))?;
    let expected_checksum = format!("sha256:{:x}", Sha256::digest(&payload_bytes));
    if wrapper.get("checksum").and_then(serde_json::Value::as_str)
        != Some(expected_checksum.as_str())
        || payload.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || payload
            .get("sourceIdentity")
            .and_then(serde_json::Value::as_str)
            != Some(source_identity)
        || payload
            .get("contentDigest")
            .and_then(serde_json::Value::as_str)
            != Some(content_digest)
        || payload.get("target").and_then(serde_json::Value::as_str) != Some(target)
    {
        return Err(projection_error("projection publication record is invalid"));
    }
    let snapshot_identity = payload
        .get("snapshotIdentity")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| projection_error("projection publication record is invalid"))?;
    parse_unix_identity(snapshot_identity)?;
    Ok(snapshot_identity.to_owned())
}

#[cfg(unix)]
fn publish_publication_record(claim: &File, final_name: &CString, bytes: &[u8]) -> Result<()> {
    let temporary_name = CString::new(format!(
        ".gsd-publication-record-{:x}.write",
        Sha256::digest(bytes)
    ))
    .unwrap();
    if relative_identity(claim, &temporary_name)?.is_some() {
        return Err(projection_error(
            "unrecognized publication record temporary was retained",
        ));
    }
    let mut temporary = create_relative_file(claim, &temporary_name)?;
    temporary.write_all(bytes).map_err(projection_error)?;
    temporary.sync_all().map_err(projection_error)?;
    rename_relative_exclusive(claim, &temporary_name, final_name)?;
    claim.sync_all().map_err(projection_error)
}

#[cfg(unix)]
fn read_publication_snapshot_record(
    claim: &File,
    source_identity: &str,
    content_digest: &str,
    target: &CString,
) -> Result<String> {
    let name = CString::new("snapshot.json").unwrap();
    let mut record = open_relative_node(claim, &name, false)?;
    let mut bytes = Vec::new();
    record.read_to_end(&mut bytes).map_err(projection_error)?;
    decode_publication_snapshot_record(&bytes, source_identity, content_digest, target)
}

#[cfg(unix)]
fn retire_publication_source(
    parent: &File,
    claim: &File,
    source_name: &CString,
    source_identity: &str,
    content_digest: &str,
) -> Result<()> {
    let retired_name = CString::new("retired").unwrap();
    if relative_identity(claim, &retired_name)?.is_some() {
        let retired = open_relative_node(claim, &retired_name, true)?;
        require_unix_identity(
            &retired,
            source_identity,
            "projection retired source identity changed",
        )?;
        if projection_content_digest_at(claim, &retired_name, true)? != content_digest {
            return Err(projection_error(
                "projection retired source content changed",
            ));
        }
        return if relative_identity(parent, source_name)?.is_none() {
            Ok(())
        } else {
            Err(projection_error(
                "projection source replacement retained as evidence",
            ))
        };
    }
    if relative_identity(parent, source_name)?.as_deref() != Some(source_identity) {
        return Err(projection_error(
            "projection source replacement retained as evidence",
        ));
    }
    if projection_content_digest_at(parent, source_name, true)? != content_digest {
        return Err(projection_error(
            "projection source replacement retained as evidence",
        ));
    }
    rename_relative_between_exclusive(parent, source_name, claim, &retired_name)?;
    parent.sync_all().map_err(projection_error)?;
    claim.sync_all().map_err(projection_error)?;
    let retired = open_relative_node(claim, &retired_name, true)?;
    require_unix_identity(
        &retired,
        source_identity,
        "projection retired source identity changed",
    )?;
    if projection_content_digest_at(claim, &retired_name, true)? != content_digest {
        return Err(projection_error(
            "projection retired source content changed",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn restore_quarantined_tree_from_snapshot_claim(
    root: &File,
    source_parent: &File,
    quarantine: &CString,
    target_parent: &File,
    target: &CString,
    identity: &str,
    content_digest: &str,
) -> Result<()> {
    let evidence = recovery_evidence_directory(root)?;
    let claim_name = tree_publication_claim_name(identity, content_digest, target);
    let snapshot_name = CString::new("snapshot").unwrap();
    let preparing_name = CString::new("snapshot.preparing.json").unwrap();
    let record_name = CString::new("snapshot.json").unwrap();
    let complete_name = CString::new("published.json").unwrap();
    let retired_name = CString::new("retired").unwrap();
    if relative_identity(&evidence, &claim_name)?.is_none() {
        if relative_identity(target_parent, target)?.is_some() {
            return Err(projection_error(
                "projection publication claim is missing for the live destination",
            ));
        }
        if unsafe { libc::mkdirat(evidence.as_raw_fd(), claim_name.as_ptr(), 0o700) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
        evidence.sync_all().map_err(projection_error)?;
    } else {
        // A crash between the publication rename fence (fchmod 0o300) and its
        // restore leaves the claim unreadable, and replay would fail to open
        // it with EACCES forever; restore the mode before opening so replay
        // can proceed. The flock below still serializes live publishers.
        if unsafe { libc::fchmodat(evidence.as_raw_fd(), claim_name.as_ptr(), 0o700, 0) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
    }
    let claim = open_relative_node(&evidence, &claim_name, true)?;
    if unsafe { libc::flock(claim.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(projection_error(
            "projection quarantine publication claim is busy",
        ));
    }
    let snapshot_identity = if relative_identity(&claim, &record_name)?.is_some() {
        read_publication_snapshot_record(&claim, identity, content_digest, target)?
    } else {
        let source = open_relative_node(source_parent, quarantine, true)?;
        require_unix_identity(
            &source,
            identity,
            "projection quarantine identity changed before snapshot",
        )?;
        if projection_content_digest_at(source_parent, quarantine, true)? != content_digest {
            return Err(projection_error(
                "projection quarantine content changed before snapshot",
            ));
        }
        if relative_identity(&claim, &snapshot_name)?.is_none() {
            if unsafe { libc::mkdirat(claim.as_raw_fd(), snapshot_name.as_ptr(), 0o700) } != 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            claim.sync_all().map_err(projection_error)?;
        }
        let snapshot = open_relative_node(&claim, &snapshot_name, true)?;
        let snapshot_identity = relative_identity(&claim, &snapshot_name)?.unwrap();
        if relative_identity(&claim, &preparing_name)?.is_none() {
            if !directory_names(&snapshot)?.is_empty() {
                return Err(projection_error(
                    "projection unbound private snapshot was retained",
                ));
            }
            let bytes =
                publication_snapshot_record(identity, &snapshot_identity, content_digest, target)?;
            publish_publication_record(&claim, &preparing_name, &bytes)?;
        } else {
            let mut preparing = open_relative_node(&claim, &preparing_name, false)?;
            let mut bytes = Vec::new();
            preparing
                .read_to_end(&mut bytes)
                .map_err(projection_error)?;
            if decode_publication_snapshot_record(&bytes, identity, content_digest, target)?
                != snapshot_identity
            {
                return Err(projection_error(
                    "projection snapshot preparation record is invalid",
                ));
            }
        }
        let mut allow_fault = true;
        copy_projection_tree_resumable(&source, &snapshot, &mut allow_fault)?;
        if projection_content_digest_at(&claim, &snapshot_name, true)? != content_digest {
            return Err(projection_error(
                "projection private snapshot content did not match reviewed evidence",
            ));
        }
        rename_relative_exclusive(&claim, &preparing_name, &record_name)?;
        claim.sync_all().map_err(projection_error)?;
        snapshot_identity
    };
    let allowed = [
        &snapshot_name,
        &preparing_name,
        &record_name,
        &complete_name,
        &retired_name,
    ];
    if directory_names(&claim)?
        .iter()
        .any(|name| !allowed.contains(&name))
    {
        return Err(projection_error(
            "projection publication claim has unexpected occupants",
        ));
    }
    if relative_identity(&claim, &complete_name)?.is_some() {
        let mut record = open_relative_node(&claim, &complete_name, false)?;
        let mut bytes = Vec::new();
        record.read_to_end(&mut bytes).map_err(projection_error)?;
        if decode_publication_snapshot_record(&bytes, identity, content_digest, target)?
            != snapshot_identity
        {
            return Err(projection_error(
                "projection publication completion record is invalid",
            ));
        }
    }
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(12, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        rename_relative_between_exclusive(source_parent, quarantine, &claim, &retired_name)?;
        claim.sync_all().map_err(projection_error)?;
        if unsafe { libc::mkdirat(source_parent.as_raw_fd(), quarantine.as_ptr(), 0o700) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
        let replacement = open_relative_node(source_parent, quarantine, true)?;
        let replacement_file = CString::new("later.md").unwrap();
        let mut file = create_relative_file(&replacement, &replacement_file)?;
        file.write_all(b"later accepted replacement\n")
            .map_err(projection_error)?;
        file.sync_all().map_err(projection_error)?;
        replacement.sync_all().map_err(projection_error)?;
        source_parent.sync_all().map_err(projection_error)?;
    }
    if relative_identity(target_parent, target)?.is_none() {
        let snapshot = open_relative_node(&claim, &snapshot_name, true)?;
        require_unix_identity(
            &snapshot,
            &snapshot_identity,
            "projection private snapshot identity changed",
        )?;
        inject_unix_mutation_boundary_fault(&claim, &snapshot_name, &snapshot, true, true)?;
        if MUTATION_BOUNDARY_FAULT
            .compare_exchange(6, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return Err(projection_error("simulated tree publication crash"));
        }
        if MUTATION_BOUNDARY_FAULT
            .compare_exchange(8, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
            || MUTATION_BOUNDARY_FAULT
                .compare_exchange(16, 0, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            let fault = CString::new("later-at-final-source.md").unwrap();
            let mut changed = create_relative_file(&snapshot, &fault)?;
            changed
                .write_all(b"later accepted private-snapshot content\n")
                .map_err(projection_error)?;
            changed.sync_all().map_err(projection_error)?;
            snapshot.sync_all().map_err(projection_error)?;
        }
        require_relative_identity(
            &claim,
            &snapshot_name,
            &snapshot_identity,
            "projection private snapshot identity changed at publication boundary",
        )?;
        if projection_content_digest_at(&claim, &snapshot_name, true)? != content_digest {
            return Err(projection_error(
                "projection private snapshot content changed at publication boundary",
            ));
        }
        if MUTATION_BOUNDARY_FAULT
            .compare_exchange(19, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let racer_name = CString::new("snapshot-racer").unwrap();
            rename_relative_exclusive(&claim, &snapshot_name, &racer_name)?;
            if unsafe { libc::mkdirat(claim.as_raw_fd(), snapshot_name.as_ptr(), 0o700) } != 0 {
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let replacement = open_relative_node(&claim, &snapshot_name, true)?;
            let later_name = CString::new("later.md").unwrap();
            let mut later = create_relative_file(&replacement, &later_name)?;
            later
                .write_all(b"later accepted replacement\n")
                .map_err(projection_error)?;
            later.sync_all().map_err(projection_error)?;
            replacement.sync_all().map_err(projection_error)?;
            claim.sync_all().map_err(projection_error)?;
        }
        require_relative_identity(
            &claim,
            &snapshot_name,
            &snapshot_identity,
            "projection private snapshot identity changed at final publication syscall",
        )?;
        if projection_content_digest_at(&claim, &snapshot_name, true)? != content_digest {
            return Err(projection_error(
                "projection private snapshot content changed at final publication syscall",
            ));
        }
        if unsafe { libc::fchmod(claim.as_raw_fd(), 0o300) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
        let rename_result =
            rename_relative_between_exclusive(&claim, &snapshot_name, target_parent, target);
        let restore_result = unsafe { libc::fchmod(claim.as_raw_fd(), 0o700) };
        rename_result?;
        if restore_result != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
        claim.sync_all().map_err(projection_error)?;
        target_parent.sync_all().map_err(projection_error)?;
        if MUTATION_BOUNDARY_FAULT
            .compare_exchange(15, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return Err(projection_error(
                "simulated post-rename tree publication crash",
            ));
        }
    }
    let published = open_relative_node(target_parent, target, true)?;
    require_unix_identity(
        &published,
        &snapshot_identity,
        "projection destination identity changed during publication replay",
    )?;
    if projection_content_digest_at(target_parent, target, true)? != content_digest {
        return Err(projection_error(
            "projection destination content changed during publication replay",
        ));
    }
    if relative_identity(&claim, &complete_name)?.is_none() {
        let bytes =
            publication_snapshot_record(identity, &snapshot_identity, content_digest, target)?;
        publish_publication_record(&claim, &complete_name, &bytes)?;
    }
    retire_publication_source(source_parent, &claim, quarantine, identity, content_digest)
}

#[cfg(target_os = "linux")]
fn exchange_relative(parent: &File, left: &CString, right: &CString) -> Result<()> {
    exchange_relative_between(parent, left, parent, right)
}

#[cfg(target_os = "linux")]
fn exchange_relative_between(
    left_parent: &File,
    left: &CString,
    right_parent: &File,
    right: &CString,
) -> Result<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            left_parent.as_raw_fd(),
            left.as_ptr(),
            right_parent.as_raw_fd(),
            right.as_ptr(),
            2u32,
        )
    };
    if result != 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn exchange_relative(parent: &File, left: &CString, right: &CString) -> Result<()> {
    exchange_relative_between(parent, left, parent, right)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn exchange_relative_between(
    left_parent: &File,
    left: &CString,
    right_parent: &File,
    right: &CString,
) -> Result<()> {
    let result = unsafe {
        libc::renameatx_np(
            left_parent.as_raw_fd(),
            left.as_ptr(),
            right_parent.as_raw_fd(),
            right.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result != 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "macos", target_os = "ios"))
))]
fn exchange_relative(_parent: &File, _left: &CString, _right: &CString) -> Result<()> {
    Err(projection_error(
        "atomic projection exchange is unavailable on this platform",
    ))
}

#[cfg(unix)]
fn publish_relative_file(parent: &File, temporary: &CString, name: &CString) -> Result<()> {
    let result = unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            parent.as_raw_fd(),
            name.as_ptr(),
        )
    };
    if result != 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    parent.sync_all().map_err(projection_error)
}

#[cfg(unix)]
fn remove_relative_file(parent: &File, name: &CString) {
    unsafe {
        libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0);
    }
}

#[cfg(unix)]
fn remove_tree_at(parent: &File, name: &CString) -> Result<()> {
    remove_node_at(parent, name, true, None)
}

#[cfg(unix)]
fn remove_node_at(
    parent: &File,
    name: &CString,
    directory_expected: bool,
    expected: Option<(u64, u64)>,
) -> Result<()> {
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let node = unsafe { File::from_raw_fd(descriptor) };
    let identity = node.metadata().map_err(projection_error)?;
    if expected.is_some_and(|value| value != (identity.dev(), identity.ino())) {
        return Err(projection_error(
            "projection child identity changed during removal",
        ));
    }
    if identity.is_dir() != directory_expected {
        return Err(Error::new(
            Status::GenericFailure,
            "projection root contains an unsupported node".to_owned(),
        ));
    }
    if directory_expected {
        remove_open_tree_contents(&node)?;
        require_relative_identity(
            parent,
            name,
            &format!("{}:{}", identity.dev(), identity.ino()),
            "projection directory identity changed during removal",
        )?;
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
    } else {
        require_relative_identity(
            parent,
            name,
            &format!("{}:{}", identity.dev(), identity.ino()),
            "projection file identity changed during removal",
        )?;
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
    }
    parent.sync_all().map_err(projection_error)
}

#[cfg(unix)]
#[derive(Clone, PartialEq, Eq)]
struct TreeDeletionEntry {
    path: String,
    identity: String,
    directory: bool,
    content_digest: Option<String>,
}

#[cfg(unix)]
fn tree_deletion_manifest_name() -> CString {
    CString::new(".gsd-delete-manifest").unwrap()
}

#[cfg(unix)]
fn tree_deletion_prepared_manifest_name() -> CString {
    CString::new(".gsd-delete-manifest.prepared").unwrap()
}

#[cfg(unix)]
fn tree_deletion_temporary_manifest_name(root_identity: &str, content_digest: &str) -> CString {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("delete-manifest\0{root_identity}\0{content_digest}").as_bytes(),)
    );
    CString::new(format!(".gsd-delete-manifest.write-{}", &digest[..32])).unwrap()
}

#[cfg(unix)]
fn tree_deletion_tombstone_name(
    root_identity: &str,
    content_digest: &str,
    logical_path: &str,
) -> CString {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!("delete-tombstone\0{root_identity}\0{content_digest}\0{logical_path}")
                .as_bytes(),
        )
    );
    CString::new(format!(".gsd-delete-tombstone-{}", &digest[..32])).unwrap()
}

#[cfg(unix)]
fn tree_deletion_placeholder_name(
    root_identity: &str,
    content_digest: &str,
    logical_path: &str,
) -> CString {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!("delete-placeholder\0{root_identity}\0{content_digest}\0{logical_path}")
                .as_bytes(),
        )
    );
    CString::new(format!(".gsd-delete-placeholder-{}", &digest[..32])).unwrap()
}

#[cfg(unix)]
fn tree_deletion_placeholder_record(
    root_identity: &str,
    content_digest: &str,
    logical_path: &str,
    identity: &str,
) -> Result<Vec<u8>> {
    publication_snapshot_record(
        root_identity,
        identity,
        content_digest,
        &CString::new(logical_path).map_err(projection_error)?,
    )
}

#[cfg(unix)]
fn read_tree_deletion_placeholder(
    placeholder: &File,
    root_identity: &str,
    content_digest: &str,
    logical_path: &str,
) -> Result<String> {
    let record_name = CString::new("placeholder.json").unwrap();
    let mut record = open_relative_node(placeholder, &record_name, false)?;
    let mut bytes = Vec::new();
    record.read_to_end(&mut bytes).map_err(projection_error)?;
    decode_publication_snapshot_record(
        &bytes,
        root_identity,
        content_digest,
        &CString::new(logical_path).map_err(projection_error)?,
    )
}

#[cfg(unix)]
fn sort_tree_deletion_entries(entries: &mut [TreeDeletionEntry]) {
    entries.sort_by(|left, right| {
        right
            .path
            .matches('/')
            .count()
            .cmp(&left.path.matches('/').count())
            .then_with(|| left.path.cmp(&right.path))
    });
}

#[cfg(unix)]
fn unix_tree_deletion_manifest_exists(root: &File) -> Result<bool> {
    Ok(
        relative_identity(root, &tree_deletion_manifest_name())?.is_some()
            || relative_identity(root, &tree_deletion_prepared_manifest_name())?.is_some(),
    )
}

#[cfg(unix)]
fn reject_uncommitted_unix_tree_deletion_manifest(
    root: &File,
    root_identity: &str,
    content_digest: &str,
) -> Result<()> {
    let temporary = tree_deletion_temporary_manifest_name(root_identity, content_digest);
    if relative_identity(root, &temporary)?.is_some() {
        return Err(projection_error(
            "unrecognized deletion manifest temporary was retained",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn directory_names(directory: &File) -> Result<Vec<CString>> {
    let descriptor = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if descriptor < 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    if unsafe { libc::lseek(descriptor, 0, libc::SEEK_SET) } < 0 {
        unsafe { libc::close(descriptor) };
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let scan = unsafe { libc::fdopendir(descriptor) };
    if scan.is_null() {
        unsafe { libc::close(descriptor) };
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let mut entries = Vec::new();
    clear_directory_scan_error();
    loop {
        let entry = unsafe { libc::readdir(scan) };
        if entry.is_null() {
            if let Some(error) = directory_scan_error() {
                unsafe { libc::closedir(scan) };
                return Err(projection_error(error));
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            entries.push(CString::new(name.to_bytes()).map_err(projection_error)?);
        }
    }
    unsafe { libc::closedir(scan) };
    entries.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(entries)
}

#[cfg(unix)]
fn collect_tree_deletion_entries(
    directory: &File,
    prefix: &str,
    entries: &mut Vec<TreeDeletionEntry>,
) -> Result<()> {
    collect_tree_deletion_entries_with_manifest(directory, prefix, entries, false)
}

#[cfg(unix)]
fn is_reserved_recovery_control_path(path: &str) -> bool {
    [
        ".gsd-delete-",
        ".gsd-publication-",
        ".gsd-projection-",
        ".gsd-control-",
        ".gsd-exchange-",
        ".gsd-evidence-",
        ".gsd-recovery-",
        ".gsd-tombstone-",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

#[cfg(unix)]
fn collect_tree_deletion_entries_with_manifest(
    directory: &File,
    prefix: &str,
    entries: &mut Vec<TreeDeletionEntry>,
    allow_committed_manifest: bool,
) -> Result<()> {
    for name in directory_names(directory)? {
        let text = name
            .to_str()
            .map_err(|_| projection_error("projection tree contains a non-UTF-8 path"))?;
        if prefix.is_empty()
            && allow_committed_manifest
            && (name == tree_deletion_manifest_name()
                || name == tree_deletion_prepared_manifest_name())
        {
            continue;
        }
        if is_reserved_recovery_control_path(text) {
            return Err(projection_error(
                "projection tree contains a reserved recovery control path",
            ));
        }
        let path = if prefix.is_empty() {
            text.to_owned()
        } else {
            format!("{prefix}/{text}")
        };
        let directory_entry = relative_is_directory(directory, &name)?;
        let node = open_relative_node(directory, &name, directory_entry)?;
        let metadata = node.metadata().map_err(projection_error)?;
        if !metadata.is_dir() && !metadata.is_file() {
            return Err(projection_error(
                "projection root contains an unsupported node",
            ));
        }
        if directory_entry {
            collect_tree_deletion_entries_with_manifest(&node, &path, entries, false)?;
        }
        entries.push(TreeDeletionEntry {
            path,
            identity: format!("{}:{}", metadata.dev(), metadata.ino()),
            directory: directory_entry,
            content_digest: if directory_entry {
                None
            } else {
                Some(projection_content_digest_at(directory, &name, false)?)
            },
        });
    }
    Ok(())
}

#[cfg(unix)]
fn encode_tree_deletion_manifest(
    root_identity: &str,
    content_digest: &str,
    entries: &[TreeDeletionEntry],
) -> Result<Vec<u8>> {
    let payload = serde_json::json!({
        "version": 1,
        "rootIdentity": root_identity,
        "contentDigest": content_digest,
        "entries": entries.iter().map(|entry| serde_json::json!({
            "path": entry.path,
            "identity": entry.identity,
            "directory": entry.directory,
            "contentDigest": entry.content_digest,
        })).collect::<Vec<_>>(),
    });
    let payload_bytes = serde_json::to_vec(&payload).map_err(projection_error)?;
    serde_json::to_vec(&serde_json::json!({
        "checksum": format!("sha256:{:x}", Sha256::digest(&payload_bytes)),
        "payload": payload,
    }))
    .map_err(projection_error)
}

#[cfg(unix)]
fn decode_tree_deletion_manifest(
    bytes: &[u8],
    root_identity: &str,
    content_digest: &str,
) -> Result<Vec<TreeDeletionEntry>> {
    let wrapper: serde_json::Value = serde_json::from_slice(bytes).map_err(projection_error)?;
    let payload = wrapper
        .get("payload")
        .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
    let payload_bytes = serde_json::to_vec(payload).map_err(projection_error)?;
    let checksum = wrapper
        .get("checksum")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
    if checksum != format!("sha256:{:x}", Sha256::digest(&payload_bytes))
        || payload.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || payload
            .get("rootIdentity")
            .and_then(serde_json::Value::as_str)
            != Some(root_identity)
        || payload
            .get("contentDigest")
            .and_then(serde_json::Value::as_str)
            != Some(content_digest)
    {
        return Err(projection_error("projection deletion manifest is invalid"));
    }
    let values = payload
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
    let mut entries = Vec::with_capacity(values.len());
    for value in values {
        let path = value
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
        if path.is_empty()
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(projection_error("projection deletion manifest is invalid"));
        }
        let identity = value
            .get("identity")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
        parse_unix_identity(identity)?;
        let directory = value
            .get("directory")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| projection_error("projection deletion manifest is invalid"))?;
        let entry_digest = value
            .get("contentDigest")
            .and_then(serde_json::Value::as_str);
        if directory != entry_digest.is_none()
            || entry_digest
                .is_some_and(|digest| !digest.starts_with("sha256:") || digest.len() != 71)
        {
            return Err(projection_error("projection deletion manifest is invalid"));
        }
        entries.push(TreeDeletionEntry {
            path: path.to_owned(),
            identity: identity.to_owned(),
            directory,
            content_digest: entry_digest.map(str::to_owned),
        });
    }
    entries.sort_by(|left, right| {
        right
            .path
            .matches('/')
            .count()
            .cmp(&left.path.matches('/').count())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(entries)
}

#[cfg(unix)]
fn read_tree_deletion_manifest(
    claimed: &File,
    name: &CString,
    root_identity: &str,
    content_digest: &str,
) -> Result<Vec<TreeDeletionEntry>> {
    let mut manifest = open_relative_node(claimed, name, false)?;
    let mut bytes = Vec::new();
    manifest.read_to_end(&mut bytes).map_err(projection_error)?;
    decode_tree_deletion_manifest(&bytes, root_identity, content_digest)
}

#[cfg(unix)]
fn publish_tree_deletion_manifest(
    claimed: &File,
    root_identity: &str,
    content_digest: &str,
    bytes: &[u8],
) -> Result<()> {
    let prepared_name = tree_deletion_prepared_manifest_name();
    let manifest_name = tree_deletion_manifest_name();
    let temporary_name = tree_deletion_temporary_manifest_name(root_identity, content_digest);
    if relative_identity(claimed, &temporary_name)?.is_some() {
        return Err(projection_error(
            "unrecognized deletion manifest temporary was retained",
        ));
    }
    let mut temporary = create_relative_file(claimed, &temporary_name)?;
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(10, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        temporary
            .write_all(&bytes[..bytes.len().min(8)])
            .map_err(projection_error)?;
        temporary.sync_all().map_err(projection_error)?;
        claimed.sync_all().map_err(projection_error)?;
        return Err(projection_error("simulated deletion manifest write crash"));
    }
    temporary.write_all(bytes).map_err(projection_error)?;
    temporary.sync_all().map_err(projection_error)?;
    rename_relative_exclusive(claimed, &temporary_name, &prepared_name)?;
    claimed.sync_all().map_err(projection_error)?;
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(9, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return Err(projection_error(
            "simulated prepared deletion manifest crash",
        ));
    }
    rename_relative_exclusive(claimed, &prepared_name, &manifest_name)?;
    claimed.sync_all().map_err(projection_error)
}

#[cfg(unix)]
fn recover_tree_deletion_manifest(
    claimed: &File,
    root_identity: &str,
    content_digest: &str,
) -> Result<Option<Vec<TreeDeletionEntry>>> {
    let manifest_name = tree_deletion_manifest_name();
    let prepared_name = tree_deletion_prepared_manifest_name();
    let committed = relative_identity(claimed, &manifest_name)?.is_some();
    let prepared = relative_identity(claimed, &prepared_name)?.is_some();
    if committed {
        let entries =
            read_tree_deletion_manifest(claimed, &manifest_name, root_identity, content_digest)?;
        if prepared {
            let prepared_entries = read_tree_deletion_manifest(
                claimed,
                &prepared_name,
                root_identity,
                content_digest,
            )?;
            if encode_tree_deletion_manifest(root_identity, content_digest, &entries)?
                != encode_tree_deletion_manifest(root_identity, content_digest, &prepared_entries)?
            {
                return Err(projection_error("projection deletion manifests conflict"));
            }
            remove_node_at(claimed, &prepared_name, false, None)?;
        }
        return Ok(Some(entries));
    }
    if !prepared {
        return Ok(None);
    }
    let entries =
        read_tree_deletion_manifest(claimed, &prepared_name, root_identity, content_digest)?;
    rename_relative_exclusive(claimed, &prepared_name, &manifest_name)?;
    claimed.sync_all().map_err(projection_error)?;
    Ok(Some(entries))
}

#[cfg(unix)]
fn verify_retired_tree(retired: &File, root_identity: &str, content_digest: &str) -> Result<()> {
    require_unix_identity(
        retired,
        root_identity,
        "projection deletion tombstone identity changed",
    )?;
    let mut expected = read_tree_deletion_manifest(
        retired,
        &tree_deletion_manifest_name(),
        root_identity,
        content_digest,
    )?;
    let mut actual = Vec::new();
    collect_tree_deletion_entries_with_manifest(retired, "", &mut actual, true)?;
    sort_tree_deletion_entries(&mut expected);
    sort_tree_deletion_entries(&mut actual);
    if actual != expected {
        return Err(projection_error(
            "projection deletion tombstone retained unexpected occupants",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn completed_tree_deletion_tombstone_exists(
    root: &File,
    parent: &File,
    source_name: &CString,
    logical_path: &str,
    root_identity: &str,
    content_digest: &str,
) -> Result<bool> {
    let evidence = recovery_evidence_directory(root)?;
    let name = tree_deletion_tombstone_name(root_identity, content_digest, logical_path);
    if relative_identity(&evidence, &name)?.is_none() {
        return Ok(false);
    }
    let retired = open_relative_node(&evidence, &name, true)?;
    if relative_identity(&evidence, &name)?.as_deref() != Some(root_identity) {
        read_tree_deletion_placeholder(&retired, root_identity, content_digest, logical_path)?;
        return Ok(false);
    }
    verify_retired_tree(&retired, root_identity, content_digest)?;
    if relative_identity(parent, source_name)?.is_some() {
        let public = open_relative_node(parent, source_name, true)?;
        let placeholder_identity =
            read_tree_deletion_placeholder(&public, root_identity, content_digest, logical_path)?;
        require_unix_identity(
            &public,
            &placeholder_identity,
            "projection deletion placeholder identity changed",
        )?;
        let placeholder_name =
            tree_deletion_placeholder_name(root_identity, content_digest, logical_path);
        if relative_identity(&evidence, &placeholder_name)?.is_none() {
            rename_relative_between_exclusive(parent, source_name, &evidence, &placeholder_name)?;
            parent.sync_all().map_err(projection_error)?;
            evidence.sync_all().map_err(projection_error)?;
        }
    }
    Ok(true)
}

#[cfg(unix)]
fn remove_claimed_tree_at(
    root: &File,
    parent: &File,
    name: &CString,
    logical_path: &str,
    claimed: &File,
    root_identity: &str,
    content_digest: &str,
) -> Result<()> {
    let evidence = recovery_evidence_directory(root)?;
    let tombstone_name = tree_deletion_tombstone_name(root_identity, content_digest, logical_path);
    if completed_tree_deletion_tombstone_exists(
        root,
        parent,
        name,
        logical_path,
        root_identity,
        content_digest,
    )? {
        return Ok(());
    }
    let mut entries = if let Some(entries) =
        recover_tree_deletion_manifest(claimed, root_identity, content_digest)?
    {
        entries
    } else {
        let temporary_name = tree_deletion_temporary_manifest_name(root_identity, content_digest);
        if relative_identity(claimed, &temporary_name)?.is_some() {
            return Err(projection_error(
                "unrecognized deletion manifest temporary was retained",
            ));
        }
        let mut entries = Vec::new();
        collect_tree_deletion_entries(claimed, "", &mut entries)?;
        if MUTATION_BOUNDARY_FAULT
            .compare_exchange(14, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let name = CString::new("later-after-consent.md").unwrap();
            let mut later = create_relative_file(claimed, &name)?;
            later
                .write_all(b"later accepted work\n")
                .map_err(projection_error)?;
            later.sync_all().map_err(projection_error)?;
            claimed.sync_all().map_err(projection_error)?;
        }
        let mut hash = Sha256::new();
        hash_projection_tree(claimed, "", &mut hash)?;
        if format!("sha256:{:x}", hash.finalize()) != content_digest {
            return Err(projection_error(
                "projection evidence content changed before deletion manifest commit",
            ));
        }
        let bytes = encode_tree_deletion_manifest(root_identity, content_digest, &entries)?;
        publish_tree_deletion_manifest(claimed, root_identity, content_digest, &bytes)?;
        let committed_entries = read_tree_deletion_manifest(
            claimed,
            &tree_deletion_manifest_name(),
            root_identity,
            content_digest,
        )?;
        if committed_entries != entries {
            return Err(projection_error(
                "projection deletion manifest changed during commit",
            ));
        }
        entries
    };
    sort_tree_deletion_entries(&mut entries);
    let mut actual = Vec::new();
    collect_tree_deletion_entries_with_manifest(claimed, "", &mut actual, true)?;
    sort_tree_deletion_entries(&mut actual);
    if actual != entries {
        return Err(projection_error(
            "projection deletion retained unexpected occupants",
        ));
    }
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(4, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return Err(projection_error("simulated tree deletion crash"));
    }
    if relative_identity(&evidence, &tombstone_name)?.is_none() {
        if unsafe { libc::mkdirat(evidence.as_raw_fd(), tombstone_name.as_ptr(), 0o700) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
        let placeholder = open_relative_node(&evidence, &tombstone_name, true)?;
        let metadata = placeholder.metadata().map_err(projection_error)?;
        let placeholder_identity = format!("{}:{}", metadata.dev(), metadata.ino());
        let bytes = tree_deletion_placeholder_record(
            root_identity,
            content_digest,
            logical_path,
            &placeholder_identity,
        )?;
        publish_publication_record(
            &placeholder,
            &CString::new("placeholder.json").unwrap(),
            &bytes,
        )?;
        evidence.sync_all().map_err(projection_error)?;
    }
    let placeholder = open_relative_node(&evidence, &tombstone_name, true)?;
    read_tree_deletion_placeholder(&placeholder, root_identity, content_digest, logical_path)?;
    if MUTATION_BOUNDARY_FAULT
        .compare_exchange(17, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let racer_name = CString::new("later-at-retirement.md").unwrap();
        let mut later = create_relative_file(claimed, &racer_name)?;
        later
            .write_all(b"later accepted work\n")
            .map_err(projection_error)?;
        later.sync_all().map_err(projection_error)?;
        claimed.sync_all().map_err(projection_error)?;
    }
    exchange_relative_between(parent, name, &evidence, &tombstone_name)?;
    parent.sync_all().map_err(projection_error)?;
    evidence.sync_all().map_err(projection_error)?;
    let retired = open_relative_node(&evidence, &tombstone_name, true)?;
    if let Err(error) = verify_retired_tree(&retired, root_identity, content_digest) {
        exchange_relative_between(parent, name, &evidence, &tombstone_name)?;
        parent.sync_all().map_err(projection_error)?;
        evidence.sync_all().map_err(projection_error)?;
        return Err(Error::new(
            Status::GenericFailure,
            format!("projection deletion retained unexpected occupants: {error}"),
        ));
    }
    completed_tree_deletion_tombstone_exists(
        root,
        parent,
        name,
        logical_path,
        root_identity,
        content_digest,
    )?;
    Ok(())
}

#[cfg(unix)]
fn remove_claimed_node_at(
    parent: &File,
    name: &CString,
    claimed: &File,
    directory: bool,
) -> Result<()> {
    let metadata = claimed.metadata().map_err(projection_error)?;
    require_relative_identity(
        parent,
        name,
        &format!("{}:{}", metadata.dev(), metadata.ino()),
        "projection evidence identity changed at final removal boundary",
    )?;
    if directory {
        remove_open_tree_contents(claimed)?;
        require_relative_identity(
            parent,
            name,
            &format!("{}:{}", metadata.dev(), metadata.ino()),
            "projection evidence identity changed at final removal boundary",
        )?;
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            return Err(projection_error(std::io::Error::last_os_error()));
        }
    } else if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    parent.sync_all().map_err(projection_error)
}

#[cfg(unix)]
fn remove_open_tree_contents(directory: &File) -> Result<()> {
    let scan_descriptor = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if scan_descriptor < 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    if unsafe { libc::lseek(scan_descriptor, 0, libc::SEEK_SET) } < 0 {
        unsafe { libc::close(scan_descriptor) };
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let scan = unsafe { libc::fdopendir(scan_descriptor) };
    if scan.is_null() {
        unsafe { libc::close(scan_descriptor) };
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    let mut entries = Vec::new();
    clear_directory_scan_error();
    loop {
        let entry = unsafe { libc::readdir(scan) };
        if entry.is_null() {
            if let Some(error) = directory_scan_error() {
                unsafe { libc::closedir(scan) };
                return Err(projection_error(error));
            }
            break;
        }
        let entry_name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if entry_name.to_bytes() != b"." && entry_name.to_bytes() != b".." {
            let name = CString::new(entry_name.to_bytes()).map_err(projection_error)?;
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                unsafe { libc::closedir(scan) };
                return Err(projection_error(std::io::Error::last_os_error()));
            }
            let stat = unsafe { stat.assume_init() };
            entries.push((
                name,
                stat.st_dev as u64,
                stat.st_ino,
                stat.st_mode & libc::S_IFMT,
            ));
        }
    }
    unsafe { libc::closedir(scan) };
    entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    for (entry, device, inode, kind) in entries {
        if kind == libc::S_IFDIR {
            remove_node_at(directory, &entry, true, Some((device, inode)))?;
        } else if kind == libc::S_IFREG {
            remove_node_at(directory, &entry, false, Some((device, inode)))?;
        } else {
            return Err(Error::new(
                Status::GenericFailure,
                "projection root contains an unsupported node".to_owned(),
            ));
        }
    }
    directory.sync_all().map_err(projection_error)
}

#[cfg(target_os = "linux")]
fn rename_relative_exclusive(parent: &File, source: &CString, target: &CString) -> Result<()> {
    rename_relative_between_exclusive(parent, source, parent, target)
}

#[cfg(target_os = "linux")]
fn rename_relative_between_exclusive(
    source_parent: &File,
    source: &CString,
    target_parent: &File,
    target: &CString,
) -> Result<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent.as_raw_fd(),
            source.as_ptr(),
            target_parent.as_raw_fd(),
            target.as_ptr(),
            1u32,
        )
    };
    if result != 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn rename_relative_exclusive(parent: &File, source: &CString, target: &CString) -> Result<()> {
    rename_relative_between_exclusive(parent, source, parent, target)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn rename_relative_between_exclusive(
    source_parent: &File,
    source: &CString,
    target_parent: &File,
    target: &CString,
) -> Result<()> {
    let result = unsafe {
        libc::renameatx_np(
            source_parent.as_raw_fd(),
            source.as_ptr(),
            target_parent.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result != 0 {
        return Err(projection_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "macos", target_os = "ios"))
))]
fn rename_relative_exclusive(_parent: &File, _source: &CString, _target: &CString) -> Result<()> {
    Err(Error::new(
        Status::GenericFailure,
        "identity-bound recursive removal is unavailable on this platform".to_owned(),
    ))
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "macos", target_os = "ios"))
))]
fn rename_relative_between_exclusive(
    _source_parent: &File,
    _source: &CString,
    _target_parent: &File,
    _target: &CString,
) -> Result<()> {
    Err(Error::new(
        Status::GenericFailure,
        "identity-bound recursive publication is unavailable on this platform".to_owned(),
    ))
}

#[cfg(test)]
mod sharing_violation_tests {
    use super::{
        is_windows_sharing_violation, projection_path_error, retry_windows_projection_operation,
    };
    use std::path::Path;

    #[cfg(windows)]
    use super::{
        open_windows_content_guard, open_windows_delete_node, open_windows_root_directory,
        windows_file_identity, windows_identity_string, ProjectionRootIdentityLock,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    #[cfg(windows)]
    use std::fs::OpenOptions;
    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;
    #[cfg(windows)]
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn windows_sharing_violation_is_the_only_transient_projection_error() {
        assert!(is_windows_sharing_violation(
            &std::io::Error::from_raw_os_error(32)
        ));
        assert!(!is_windows_sharing_violation(
            &std::io::Error::from_raw_os_error(5)
        ));
    }

    #[test]
    fn windows_sharing_violation_names_the_faulting_path_and_holder() {
        let error = projection_path_error(
            Path::new(r"C:\repo\.gsd\worktrees\M001"),
            std::io::Error::from_raw_os_error(32),
        );
        let message = error.to_string();

        assert!(message.contains(r"C:\repo\.gsd\worktrees\M001"));
        assert!(message.contains("another process holds an incompatible handle"));
        assert!(message.contains("os error 32"));
    }

    #[test]
    fn windows_projection_operation_retries_sharing_violations() {
        let mut attempts = 0;
        let mut waits = Vec::new();
        let result = retry_windows_projection_operation(
            r"renaming projection child from C:\repo\.gsd\old.md to C:\repo\.gsd\new.md",
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(std::io::Error::from_raw_os_error(32))
                } else {
                    Ok("renamed")
                }
            },
            |delay_ms| waits.push(delay_ms),
        )
        .unwrap();

        assert_eq!(result, "renamed");
        assert_eq!(attempts, 3);
        assert_eq!(waits, vec![5, 10]);
    }

    #[test]
    fn windows_projection_operation_exhaustion_names_both_rename_paths() {
        let mut attempts = 0;
        let operation =
            r"renaming projection child from C:\repo\.gsd\old.md to C:\repo\.gsd\new.md";
        let error = retry_windows_projection_operation(
            operation,
            || {
                attempts += 1;
                Err::<(), _>(std::io::Error::from_raw_os_error(32))
            },
            |_| {},
        )
        .unwrap_err();
        let message = error.to_string();

        assert_eq!(attempts, 5);
        assert!(message.contains(operation));
        assert!(message.contains("after 5 attempts"));
        assert!(message.contains("os error 32"));
    }

    #[test]
    fn windows_projection_operation_does_not_retry_permanent_errors() {
        let mut attempts = 0;
        let mut waits = Vec::new();
        let error = retry_windows_projection_operation(
            r"opening projection child at C:\repo\.gsd\PLAN.md",
            || {
                attempts += 1;
                Err::<(), _>(std::io::Error::from_raw_os_error(5))
            },
            |delay_ms| waits.push(delay_ms),
        )
        .unwrap_err();

        assert_eq!(attempts, 1);
        assert!(waits.is_empty());
        assert!(error.to_string().contains("os error 5"));
    }

    #[cfg(windows)]
    #[test]
    fn projection_exchange_retries_locked_plan_and_reports_the_operation() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "gsd-projection-locked-plan-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let plan = directory.join("01-01-PLAN.md");
        let temporary = directory.join(".gsd-projection-tmp-plan");
        let guard = directory.join(".gsd-projection-exchange-plan");
        std::fs::write(&plan, b"old plan").unwrap();
        std::fs::write(&temporary, b"new plan").unwrap();
        std::fs::write(&guard, b"").unwrap();

        let root_file = open_windows_root_directory(&directory).unwrap();
        let (volume, id) = windows_file_identity(&root_file).unwrap();
        drop(root_file);
        let mut lock = ProjectionRootIdentityLock::new(
            directory.to_string_lossy().into_owned(),
            volume.to_string(),
            id.to_string(),
        )
        .unwrap();
        let plan_identity =
            windows_identity_string(&open_windows_delete_node(&plan).unwrap()).unwrap();
        let temporary_identity =
            windows_identity_string(&open_windows_delete_node(&temporary).unwrap()).unwrap();
        let guard_identity =
            windows_identity_string(&open_windows_delete_node(&guard).unwrap()).unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&plan)
            .unwrap();

        let message = lock
            .exchange_paths(
                "01-01-PLAN.md".to_owned(),
                ".gsd-projection-tmp-plan".to_owned(),
                plan_identity.clone(),
                temporary_identity.clone(),
                ".gsd-projection-exchange-plan".to_owned(),
                guard_identity.clone(),
            )
            .unwrap_err()
            .to_string();
        assert!(message.contains("opening projection child"));
        assert!(message.contains(plan.to_string_lossy().as_ref()));
        assert!(message.contains("after 5 attempts"));
        assert!(message.contains("os error 32"));

        drop(held);
        lock.exchange_paths(
            "01-01-PLAN.md".to_owned(),
            ".gsd-projection-tmp-plan".to_owned(),
            plan_identity,
            temporary_identity,
            ".gsd-projection-exchange-plan".to_owned(),
            guard_identity,
        )
        .unwrap();
        assert_eq!(std::fs::read(&plan).unwrap(), b"new plan");
        lock.close().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn content_guard_sharing_violation_names_the_faulting_path() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "gsd-projection-content-guard-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("held.txt");
        std::fs::write(&path, b"held").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .unwrap();

        let message = open_windows_content_guard(&path).unwrap_err().to_string();
        assert!(message.contains(path.to_string_lossy().as_ref()));
        assert!(message.contains("another process holds an incompatible handle"));
        assert!(message.contains("os error 32"));

        drop(held);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(tag: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "gsd-sqlite-file-lock-{tag}-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn identity(&self, name: &str) -> String {
            node_identity(&self.0.join(name))
        }

        fn write(&self, name: &str, content: &[u8]) -> String {
            std::fs::write(self.0.join(name), content).unwrap();
            self.identity(name)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn node_identity(path: &Path) -> String {
        let metadata = std::fs::metadata(path).unwrap();
        format!("{}:{}", metadata.dev(), metadata.ino())
    }

    fn open_lock(root: &TestRoot) -> ProjectionRootIdentityLock {
        let root_identity = node_identity(root.path());
        let (device, inode) = root_identity.split_once(':').unwrap();
        ProjectionRootIdentityLock::new(
            root.path().to_string_lossy().into_owned(),
            device.to_owned(),
            inode.to_owned(),
        )
        .unwrap()
    }

    #[test]
    fn projection_parts_rejects_non_canonical_paths() {
        for path in [
            "", ".", "..", "a/../b", "../a", "a//b", "/a", "a/", "a/./b", "a\\b", "..\\a",
            "a\\..\\b",
        ] {
            assert!(
                projection_parts(path).is_err(),
                "path {path:?} must be rejected"
            );
        }
        for path in ["a", "a/b/c", ".gsd-control-x", "a b/c-d_e.txt"] {
            assert!(
                projection_parts(path).is_ok(),
                "path {path:?} must be accepted"
            );
        }
    }

    #[test]
    fn hash_open_file_digests_through_the_handle() {
        let root = TestRoot::new("hash-file");
        let content = b"journaled projection content\nwith multiple lines\n";
        root.write("evidence.txt", content);
        let lock = open_lock(&root);
        let (parent, name) = lock.open_parent("evidence.txt", false).unwrap();
        let mut node = open_relative_node(&parent, &name, false).unwrap();
        let mut hash = Sha256::new();
        hash_open_file(&mut node, &mut hash).unwrap();
        assert_eq!(
            format!("sha256:{:x}", hash.finalize()),
            format!("sha256:{:x}", Sha256::digest(content))
        );
    }

    #[test]
    fn projection_content_digest_at_hashes_tree_via_open_handles() {
        let root = TestRoot::new("hash-tree");
        std::fs::create_dir_all(root.path().join("tree/sub")).unwrap();
        let content_a = b"alpha\n";
        let content_b = b"beta beta\n";
        root.write("tree/a.txt", content_a);
        root.write("tree/sub/b.txt", content_b);
        let lock = open_lock(&root);
        let root_file = lock.file.as_ref().unwrap();
        let file_digest =
            projection_content_digest_at(root_file, &CString::new("tree/a.txt").unwrap(), false)
                .unwrap();
        assert_eq!(
            file_digest,
            format!("sha256:{:x}", Sha256::digest(content_a))
        );
        let mut expected = Sha256::new();
        expected.update(b"");
        expected.update(b"\0directory\0");
        expected.update(b"a.txt");
        expected.update(b"\0file\0");
        expected.update(content_a);
        expected.update(b"\0");
        expected.update(b"sub");
        expected.update(b"\0directory\0");
        expected.update(b"sub/b.txt");
        expected.update(b"\0file\0");
        expected.update(content_b);
        expected.update(b"\0");
        let tree_digest =
            projection_content_digest_at(root_file, &CString::new("tree").unwrap(), true).unwrap();
        assert_eq!(tree_digest, format!("sha256:{:x}", expected.finalize()));
    }

    #[test]
    fn exchange_paths_completes_and_replays_idempotently() {
        let root = TestRoot::new("exchange");
        let left_identity = root.write("left", b"left\n");
        let right_identity = root.write("right", b"right\n");
        let guard_identity = root.write("guard", b"guard\n");
        let lock = open_lock(&root);
        for attempt in 0..2 {
            lock.exchange_paths(
                "left".to_owned(),
                "right".to_owned(),
                left_identity.clone(),
                right_identity.clone(),
                "guard".to_owned(),
                guard_identity.clone(),
            )
            .unwrap_or_else(|error| panic!("exchange attempt {attempt} failed: {error}"));
            assert_eq!(root.identity("left"), right_identity);
            assert_eq!(root.identity("right"), left_identity);
            assert!(!root.path().join("guard").exists());
        }
    }

    #[test]
    fn exchange_paths_completes_from_intermediate_state() {
        let root = TestRoot::new("exchange-partial");
        let left_identity = root.write("f1", b"left\n");
        let right_identity = root.write("f2", b"right\n");
        let guard_identity = root.write("f3", b"guard\n");
        // Arrange the intermediate state left=f1, right=f3, guard=f2, as if a
        // crash interrupted the journaled exchange after one swap.
        std::fs::rename(root.path().join("f1"), root.path().join("left")).unwrap();
        std::fs::rename(root.path().join("f2"), root.path().join("guard")).unwrap();
        std::fs::rename(root.path().join("f3"), root.path().join("right")).unwrap();
        let lock = open_lock(&root);
        lock.exchange_paths(
            "left".to_owned(),
            "right".to_owned(),
            left_identity.clone(),
            right_identity.clone(),
            "guard".to_owned(),
            guard_identity.clone(),
        )
        .unwrap();
        assert_eq!(root.identity("left"), right_identity);
        assert_eq!(root.identity("right"), left_identity);
        assert!(!root.path().join("guard").exists());
        // Replay after completion is a no-op even if the guard is gone.
        lock.exchange_paths(
            "left".to_owned(),
            "right".to_owned(),
            left_identity,
            right_identity,
            "guard".to_owned(),
            guard_identity,
        )
        .unwrap();
    }

    #[test]
    fn exchange_paths_rejects_unexpected_guard_occupant() {
        let root = TestRoot::new("exchange-occupant");
        let left_identity = root.write("left", b"left\n");
        let right_identity = root.write("right", b"right\n");
        let foreign_identity = root.write("guard", b"foreign\n");
        let lock = open_lock(&root);
        let result = lock.exchange_paths(
            "left".to_owned(),
            "right".to_owned(),
            left_identity,
            right_identity,
            "guard".to_owned(),
            "0:0".to_owned(),
        );
        assert!(result.is_err());
        // The unexpected occupant must be retained for review.
        assert_eq!(root.identity("guard"), foreign_identity);
    }

    #[test]
    fn publish_file_temporary_rejects_and_reclaims_the_temporary() {
        let root = TestRoot::new("publish-temporary");
        let lock = open_lock(&root);
        let temporary = ".gsd-projection-tmp-target.txt".to_owned();
        let identity = lock
            .prepare_file_temporary(temporary.clone(), b"content\n".to_vec().into())
            .unwrap();
        assert!(root.path().join(&temporary).exists());
        let result =
            lock.publish_file_temporary("target.txt".to_owned(), temporary.clone(), identity);
        assert!(result.is_err());
        assert!(
            !root.path().join(&temporary).exists(),
            "rejected publication must not leak the journal temporary"
        );
    }
}
