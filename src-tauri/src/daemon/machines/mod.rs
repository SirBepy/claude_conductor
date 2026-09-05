//! Machine identity for multi-machine federation: this daemon's own identity
//! plus the peer daemons it has paired with. See `registry.rs`. The HTTP
//! client for actually talking to a paired peer daemon lives in
//! `peer_client.rs`.

pub mod peer_client;
pub mod registry;

pub use peer_client::{client_for, reach_url, PeerClient, PeerError};
pub use registry::{MachineRegistry, MachinesFile, PeerMachine, PeerMachineView, SelfMachine};
pub(crate) use registry::now_secs;
