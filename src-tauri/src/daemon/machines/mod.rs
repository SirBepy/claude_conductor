//! Machine identity for multi-machine federation: this daemon's own identity
//! plus the peer daemons it has paired with. See `registry.rs`.

pub mod registry;

pub use registry::{MachineRegistry, MachinesFile, PeerMachine, PeerMachineView, SelfMachine};
